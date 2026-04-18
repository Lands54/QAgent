import type { SessionService } from "../../session/index.js";
import type {
  MemoryRecord,
  ModelClient,
  PendingApprovalCheckpoint,
  RuntimeEvent,
  RuntimeConfig,
  UIMessage,
} from "../../types.js";
import { createId } from "../../utils/index.js";
import {
  CompactSessionService,
  type CompactSessionResult,
} from "../compactSessionService.js";
import type { HeadAgentRuntime } from "../agentRuntime.js";
import { AgentRuntimeFactory } from "../agentRuntimeFactory.js";
import { AgentLifecycleService } from "./agentLifecycleService.js";
import { AgentNavigationService } from "./agentNavigationService.js";
import { AgentRegistry } from "./agentRegistry.js";
import { type PostRunJob, HookPipeline } from "./hookPipeline.js";
import { RuntimeViewProjector } from "./runtimeViewProjector.js";

export class RuntimeStateSyncService {
  private readonly pendingPostRunJobKeys = new Set<string>();
  private readonly postRunJobs: PostRunJob[] = [];
  private drainingPostRunJobs = false;
  private disposed = false;

  public constructor(
    private readonly registry: AgentRegistry,
    private readonly navigation: AgentNavigationService,
    private readonly runtimeFactory: AgentRuntimeFactory,
    private readonly lifecycle: AgentLifecycleService,
    private readonly hookPipeline: HookPipeline,
    private readonly sessionService: SessionService,
    private readonly projector: RuntimeViewProjector,
    private readonly autoCompactFailureCountByAgent: Map<string, number>,
    private readonly emitChange: () => void,
    private readonly emitRuntimeEvent: (event: RuntimeEvent) => void,
    private readonly getConfig: () => RuntimeConfig,
    private readonly setConfig: (config: RuntimeConfig) => void,
    private readonly setModelClient: (client: ModelClient) => void,
    private readonly getHelperAgentAutoCleanupEnabled: () => boolean,
  ) {}

  public async rebuildModelRuntime(
    config: RuntimeConfig,
    modelClient: ModelClient,
  ): Promise<void> {
    if (this.hasBusyAgents()) {
      throw new Error("请先让所有 Agent 处于空闲状态，再修改模型配置。");
    }
    this.setConfig(config);
    this.setModelClient(modelClient);
    this.runtimeFactory.updateSharedDependencies(config, modelClient);
    await Promise.all(
      this.registry.getEntries().map(async (entry) => {
        await this.runtimeFactory.refreshRuntime(entry.runtime, config, modelClient);
      }),
    );
    this.emitChange();
  }

  public hasBusyAgents(): boolean {
    return this.registry.hasBusyAgents();
  }

  public async submitInputToActiveAgent(input: string): Promise<void> {
    await this.submitInputToAgent(this.registry.getActiveAgentId(), input);
  }

  public async submitInputToAgent(
    agentId: string,
    input: string,
    options?: {
      activate?: boolean;
      skipFetchMemoryHook?: boolean;
      approvalMode?: "interactive" | "checkpoint";
    },
  ): Promise<void> {
    const resolvedAgentId = this.navigation.resolveExecutorId(agentId);
    const runtime = this.registry.requireRuntime(resolvedAgentId);
    if (options?.activate) {
      await this.navigation.switchWorkline(runtime.headId);
    }
    await runtime.submitInput(input, {
      buildModelInputAppendix: async () => {
        return this.hookPipeline.buildModelInputAppendix(
          runtime,
          input,
          options?.skipFetchMemoryHook,
        );
      },
      approvalMode: options?.approvalMode,
    });
  }

  public async runAgentPrompt(
    input: string,
    options?: {
      agentId?: string;
      activate?: boolean;
      approvalMode?: "interactive" | "checkpoint";
    },
  ): Promise<{
    settled: "completed" | "approval_required" | "interrupted" | "error";
    executor: ReturnType<RuntimeViewProjector["toExecutorView"]>;
    checkpoint?: PendingApprovalCheckpoint;
    uiMessages: ReadonlyArray<UIMessage>;
  }> {
    const targetAgentId = options?.agentId ?? this.registry.getActiveAgentId();
    const runtime = this.registry.requireRuntime(targetAgentId);
    const beforeUiCount = runtime.getSnapshot().uiMessages.length;
    await this.submitInputToAgent(targetAgentId, input, {
      activate: options?.activate,
      approvalMode: options?.approvalMode ?? "checkpoint",
    });
    const uiMessages = runtime.getSnapshot().uiMessages.slice(beforeUiCount);
    const checkpoint = runtime.getPendingApprovalCheckpoint();
    const executor = this.projector.toExecutorView(runtime.getViewState());
    if (checkpoint) {
      return {
        settled: "approval_required",
        executor,
        checkpoint,
        uiMessages,
      };
    }
    if (executor.status === "error") {
      return {
        settled: "error",
        executor,
        uiMessages,
      };
    }
    if (executor.status === "interrupted") {
      return {
        settled: "interrupted",
        executor,
        uiMessages,
      };
    }
    return {
      settled: "completed",
      executor,
      uiMessages,
    };
  }

  public async interruptAgent(agentId?: string): Promise<void> {
    const resolvedAgentId = agentId
      ? this.navigation.resolveExecutorId(agentId)
      : this.registry.getActiveAgentId();
    await this.registry.requireRuntime(resolvedAgentId).interrupt();
  }

  public async resumeAgent(agentId?: string): Promise<void> {
    const resolvedAgentId = agentId
      ? this.navigation.resolveExecutorId(agentId)
      : this.registry.getActiveAgentId();
    await this.registry.requireRuntime(resolvedAgentId).resume();
  }

  public async approvePendingRequest(
    approved: boolean,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    const resolvedAgentId = this.navigation.resolveExecutorId(agentId);
    await this.registry.requireRuntime(resolvedAgentId).resolveApproval(approved);
  }

  public getPendingApprovalCheckpoint(input?: {
    checkpointId?: string;
    agentId?: string;
    headId?: string;
  }): PendingApprovalCheckpoint | undefined {
    const runtime = this.findRuntimeForPendingApproval(input);
    return runtime?.getPendingApprovalCheckpoint();
  }

  public async resolvePendingApprovalCheckpoint(
    approved: boolean,
    input?: {
      checkpointId?: string;
      agentId?: string;
      headId?: string;
    },
  ): Promise<{
    settled: "completed" | "approval_required" | "interrupted" | "error";
    executor: ReturnType<RuntimeViewProjector["toExecutorView"]>;
    checkpoint?: PendingApprovalCheckpoint;
    uiMessages: ReadonlyArray<UIMessage>;
  }> {
    const runtime = this.findRuntimeForPendingApproval(input);
    if (!runtime) {
      throw new Error("当前没有待处理的审批请求。");
    }
    const existingCheckpoint = runtime.getPendingApprovalCheckpoint()
      ?? await this.sessionService.getPendingApprovalCheckpoint(runtime.headId);
    if (!existingCheckpoint) {
      throw new Error("当前没有待处理的审批请求。");
    }
    const beforeUiCount = runtime.getSnapshot().uiMessages.length;
    await runtime.resolveApproval(approved);
    const uiMessages = runtime.getSnapshot().uiMessages.slice(beforeUiCount);
    const checkpoint = runtime.getPendingApprovalCheckpoint();
    const executor = this.projector.toExecutorView(runtime.getViewState());
    if (checkpoint) {
      return {
        settled: "approval_required",
        executor,
        checkpoint,
        uiMessages,
      };
    }
    if (executor.status === "error") {
      return {
        settled: "error",
        executor,
        uiMessages,
      };
    }
    if (executor.status === "interrupted") {
      return {
        settled: "interrupted",
        executor,
        uiMessages,
      };
    }
    return {
      settled: "completed",
      executor,
      uiMessages,
    };
  }

  public async clearActiveAgentUi(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    await this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId)).clearUiMessages();
  }

  public async resetActiveAgentModelContext(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<{
    resetEntryCount: number;
  }> {
    return this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId)).resetModelContext();
  }

  public async recordSlashCommandOnActiveAgent(
    command: string,
    messages: ReadonlyArray<UIMessage>,
    agentId = this.registry.getActiveAgentId(),
    input?: {
      includeInModelContext?: boolean;
    },
  ): Promise<void> {
    await this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId))
      .recordSlashCommand(command, messages, input);
  }

  public async appendUiMessagesToActiveAgent(
    messages: ReadonlyArray<UIMessage>,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    await this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId))
      .appendUiMessages(messages);
  }

  public async setUiContextEnabled(
    enabled: boolean,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    const resolvedAgentId = this.navigation.resolveExecutorId(agentId);
    const runtime = this.registry.requireRuntime(resolvedAgentId);
    await runtime.setUiContextEnabled(enabled);
    this.emitChange();
  }

  public async compactSession(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<CompactSessionResult> {
    const resolvedAgentId = this.navigation.resolveExecutorId(agentId);
    const runtime = this.registry.requireRuntime(resolvedAgentId);
    if (runtime.promptProfile !== "default") {
      throw new Error("只有普通对话 agent 支持 compact。");
    }
    if (runtime.isRunning()) {
      throw new Error("运行中的 agent 不能手动 compact，请先等待或中断。");
    }
    const result = await new CompactSessionService(this, this.getConfig()).run({
      targetAgentId: runtime.agentId,
      reason: "manual",
      force: true,
    });
    this.autoCompactFailureCountByAgent.delete(runtime.agentId);
    await runtime.refreshSessionState();
    this.emitChange();
    return result;
  }

  public async flushCheckpointsOnExit(): Promise<void> {
    await this.lifecycle.flushCheckpointsOnExit();
  }

  public async cleanupCompletedAgent(agentId: string): Promise<void> {
    await this.lifecycle.cleanupCompletedAgent(agentId);
  }

  public getBaseSystemPrompt(): string | undefined {
    return this.getConfig().model.systemPrompt;
  }

  public getRuntime(agentId: string): HeadAgentRuntime {
    return this.registry.requireRuntime(agentId);
  }

  public async spawnTaskAgent(input: {
    name: string;
    sourceAgentId?: string;
    activate?: boolean;
    approvalMode?: "always" | "risky" | "never";
    promptProfile?: "default" | "auto-memory" | "fetch-memory" | "compact-session";
    toolMode?: "shell" | "none";
    autoMemoryFork?: boolean;
    retainOnCompletion?: boolean;
    seedModelMessages?: ReadonlyArray<{
      id: string;
      role: "system" | "user" | "assistant" | "tool";
      content: string;
      name?: string;
      toolCallId?: string;
      toolCalls?: unknown;
      createdAt: string;
    }>;
    seedUiMessages?: UIMessage[];
    lastUserPrompt?: string;
    buildRuntimeOverrides?: (head: Parameters<AgentLifecycleService["spawnAgent"]>[1]["buildRuntimeOverrides"] extends ((head: infer T) => unknown) ? T : never) => {
      promptProfile?: "default" | "auto-memory" | "fetch-memory" | "compact-session";
      toolMode?: "shell" | "none";
      systemPrompt?: string;
      maxAgentSteps?: number;
      environment?: Record<string, string>;
    };
  }): Promise<{ id: string }> {
    const agent = await this.lifecycle.spawnAgent("task", input as never);
    return {
      id: agent.id,
    };
  }

  public shouldAutoCleanupHelperAgent(): boolean {
    return this.getHelperAgentAutoCleanupEnabled();
  }

  public async clearHelperAgents(
    listHelperAgents: () => Array<{ id: string }>,
  ): Promise<{
    cleared: number;
    skippedRunning: number;
  }> {
    const helperAgents = listHelperAgents();
    let cleared = 0;
    let skippedRunning = 0;

    for (const agent of helperAgents) {
      const runtime = this.registry.requireRuntime(agent.id);
      if (runtime.isRunning()) {
        skippedRunning += 1;
        continue;
      }
      await this.lifecycle.cleanupCompletedAgent(agent.id);
      if (!this.registry.getEntry(agent.id)) {
        cleared += 1;
      }
    }

    this.emitChange();
    return {
      cleared,
      skippedRunning,
    };
  }

  public async clearLegacyAgents(
    listLegacyAgents: () => Array<{ id: string }>,
  ): Promise<{
    cleared: number;
    skippedRunning: number;
    skippedActive: number;
  }> {
    const legacyAgents = listLegacyAgents();
    let cleared = 0;
    let skippedRunning = 0;
    let skippedActive = 0;

    for (const agent of legacyAgents) {
      if (agent.id === this.registry.getActiveAgentId()) {
        skippedActive += 1;
        continue;
      }
      const runtime = this.registry.requireRuntime(agent.id);
      if (runtime.isRunning()) {
        skippedRunning += 1;
        continue;
      }
      await this.lifecycle.closeAgent(agent.id);
      if (!this.registry.getEntry(agent.id)) {
        cleared += 1;
      }
    }

    this.emitChange();
    return {
      cleared,
      skippedRunning,
      skippedActive,
    };
  }

  public async handleRuntimeCompleted(runtime: HeadAgentRuntime): Promise<void> {
    const entry = this.registry.getEntry(runtime.agentId);
    if (!entry) {
      return;
    }

    this.enqueuePostRunJobs(runtime);

    if (runtime.kind === "task" && entry.mergeIntoAgentId && entry.mergePending) {
      const targetRuntime = this.registry.requireRuntime(entry.mergeIntoAgentId);
      await this.sessionService.mergeHeadIntoHead(
        targetRuntime.headId,
        runtime.headId,
        entry.mergeAssets ?? ["digest", "memory"],
        targetRuntime.getSnapshot(),
      );
      entry.mergePending = false;
      await targetRuntime.refreshSessionState();
      this.emitChange();
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.postRunJobs.length = 0;
    this.pendingPostRunJobKeys.clear();
  }

  public enqueuePostRunJobs(runtime: HeadAgentRuntime): void {
    for (const job of this.hookPipeline.collectPostRunJobs(runtime)) {
      const key = this.getPostRunJobKey(job);
      if (this.pendingPostRunJobKeys.has(key)) {
        continue;
      }
      this.pendingPostRunJobKeys.add(key);
      this.postRunJobs.push(job);
    }

    if (this.drainingPostRunJobs || this.postRunJobs.length === 0) {
      return;
    }

    this.drainingPostRunJobs = true;
    void this.drainPostRunJobs();
  }

  public async drainPostRunJobs(): Promise<void> {
    try {
      while (!this.disposed && this.postRunJobs.length > 0) {
        const job = this.postRunJobs.shift();
        if (!job) {
          continue;
        }

        try {
          await this.hookPipeline.runPostRunJob(job);
        } catch (error) {
          await this.handlePostRunJobFailure(job, error);
        } finally {
          this.pendingPostRunJobKeys.delete(this.getPostRunJobKey(job));
        }
      }
    } finally {
      this.drainingPostRunJobs = false;
      if (!this.disposed && this.postRunJobs.length > 0) {
        this.drainingPostRunJobs = true;
        void this.drainPostRunJobs();
      }
    }
  }

  public async handlePostRunJobFailure(
    job: PostRunJob,
    error: unknown,
  ): Promise<void> {
    if (job.kind !== "auto-memory-fork") {
      return;
    }

    const runtime = this.registry.getEntry(job.agentId)?.runtime;
    const message = error instanceof Error
      ? error.message
      : String(error);

    if (!runtime || this.disposed) {
      return;
    }

    await runtime.appendUiMessages([
      {
        id: createId("ui"),
        role: "error",
        content: `自动 memory fork 失败：${message}`,
        createdAt: new Date().toISOString(),
      },
    ]);
    this.emitRuntimeEvent({
      id: createId("event"),
      type: "runtime.warning",
      createdAt: new Date().toISOString(),
      sessionId: runtime.sessionId,
      worklineId: runtime.headId,
      executorId: runtime.agentId,
      headId: runtime.headId,
      agentId: runtime.agentId,
      payload: {
        message: `自动 memory fork 失败：${message}`,
        source: "post-run.auto-memory-fork",
      },
    });
    this.emitChange();
  }

  public getPostRunJobKey(job: PostRunJob): string {
    if (job.kind === "auto-memory-fork") {
      return `${job.kind}:${job.agentId}:${job.sourceHash}`;
    }
    return `${job.kind}:${job.agentId}`;
  }

  private findRuntimeForPendingApproval(input?: {
    checkpointId?: string;
    agentId?: string;
    headId?: string;
  }): HeadAgentRuntime | undefined {
    if (input?.checkpointId) {
      return this.registry.getEntries().find((entry) => {
        return entry.runtime.getPendingApprovalCheckpoint()?.checkpointId === input.checkpointId;
      })?.runtime;
    }
    if (input?.agentId) {
      return this.registry.requireRuntime(this.navigation.resolveExecutorId(input.agentId));
    }
    if (input?.headId) {
      return this.registry.getEntryByHeadId(input.headId)?.runtime;
    }
    return this.registry.getEntries().find((entry) => {
      return Boolean(entry.runtime.getPendingApprovalCheckpoint());
    })?.runtime;
  }
}
