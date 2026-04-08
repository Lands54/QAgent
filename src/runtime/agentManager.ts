import { EventEmitter } from "node:events";

import type { PromptAssembler } from "../context/index.js";
import type {
  SessionService,
  SessionCheckoutResult,
  SessionInitializationResult,
} from "../session/index.js";
import type { ApprovalPolicy } from "../tool/index.js";
import type {
  AgentViewState,
  ApprovalMode,
  MemoryRecord,
  ModelClient,
  PendingApprovalCheckpoint,
  RuntimeEvent,
  RuntimeConfig,
  SessionCommitListView,
  SessionCommitRecord,
  SessionHeadListView,
  SessionListView,
  SessionLogEntry,
  SessionRefInfo,
  SkillManifest,
  UIMessage,
} from "../types.js";
import type { AgentRuntimeCallbacks, HeadAgentRuntime } from "./agentRuntime.js";
import { AgentRuntimeFactory } from "./agentRuntimeFactory.js";
import {
  AgentLifecycleService,
  type SpawnAgentOptions,
} from "./application/agentLifecycleService.js";
import { AgentNavigationService } from "./application/agentNavigationService.js";
import { AgentRegistry } from "./application/agentRegistry.js";
import { HookPipeline } from "./application/hookPipeline.js";
import {
  CompactSessionService,
  type CompactSessionResult,
} from "./compactSessionService.js";

type Listener = () => void;
type RuntimeEventListener = (event: RuntimeEvent) => void;

interface PendingAgentInput {
  input: string;
  options?: {
    skipFetchMemoryHook?: boolean;
    approvalMode?: "interactive" | "checkpoint";
  };
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface AgentManagerInitializationInput {
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
  resumeSessionId?: string;
}

export class AgentManager {
  private readonly events = new EventEmitter();
  private readonly registry = new AgentRegistry();
  private readonly runtimeFactory: AgentRuntimeFactory;
  private readonly navigation: AgentNavigationService;
  private readonly lifecycle: AgentLifecycleService;
  private readonly hookPipeline: HookPipeline;
  private readonly lastAutoMemoryForkSourceHashByAgent = new Map<string, string>();
  private readonly autoCompactFailureCountByAgent = new Map<string, number>();
  private readonly pendingInputsByAgent = new Map<string, PendingAgentInput[]>();
  private readonly inputDrainByAgent = new Map<string, Promise<void>>();
  private fetchMemoryHookEnabled = true;
  private saveMemoryHookEnabled = true;
  private autoCompactHookEnabled = true;
  private helperAgentAutoCleanupEnabled = true;

  public constructor(
    private config: RuntimeConfig,
    private modelClient: ModelClient,
    private readonly promptAssembler: PromptAssembler,
    private readonly sessionService: SessionService,
    private readonly approvalPolicy: ApprovalPolicy,
    private readonly getAvailableSkills: () => SkillManifest[],
  ) {
    this.runtimeFactory = new AgentRuntimeFactory(
      config,
      modelClient,
      promptAssembler,
      sessionService,
      approvalPolicy,
      getAvailableSkills,
    );
    this.navigation = new AgentNavigationService({
      registry: this.registry,
      sessionService,
      runtimeFactory: this.runtimeFactory,
      createRuntimeCallbacks: () => this.createRuntimeCallbacks(),
      emitChange: () => this.emitChange(),
    });
    this.lifecycle = new AgentLifecycleService({
      registry: this.registry,
      navigation: this.navigation,
      sessionService,
      runtimeFactory: this.runtimeFactory,
      createRuntimeCallbacks: () => this.createRuntimeCallbacks(),
      emitChange: () => this.emitChange(),
      lastAutoMemoryForkSourceHashByAgent:
        this.lastAutoMemoryForkSourceHashByAgent,
      autoCompactFailureCountByAgent: this.autoCompactFailureCountByAgent,
    });
    this.hookPipeline = new HookPipeline({
      config,
      coordinator: this,
      getAvailableSkills: this.getAvailableSkills,
      getFetchMemoryHookEnabled: () => this.fetchMemoryHookEnabled,
      getSaveMemoryHookEnabled: () => this.saveMemoryHookEnabled,
      getAutoCompactHookEnabled: () => this.autoCompactHookEnabled,
      autoCompactFailureCountByAgent: this.autoCompactFailureCountByAgent,
      lastAutoMemoryForkSourceHashByAgent:
        this.lastAutoMemoryForkSourceHashByAgent,
      emitChange: () => this.emitChange(),
    });
  }

  public subscribe(listener: Listener): () => void {
    this.events.on("change", listener);
    return () => {
      this.events.off("change", listener);
    };
  }

  public subscribeRuntimeEvents(listener: RuntimeEventListener): () => void {
    this.events.on("runtime-event", listener);
    return () => {
      this.events.off("runtime-event", listener);
    };
  }

  public async initialize(
    input: AgentManagerInitializationInput,
  ): Promise<SessionInitializationResult> {
    const initialized = await this.sessionService.initialize(input);
    this.registry.initializeActiveAgent(initialized.head.id);

    const headsView = await this.sessionService.listHeads(initialized.snapshot);
    for (const item of headsView.heads) {
      const head = await this.sessionService.getHead(item.id);
      const snapshot =
        head.id === initialized.head.id
          ? initialized.snapshot
          : await this.sessionService.getHeadSnapshot(head.id);
      const ref =
        head.id === initialized.head.id
          ? initialized.ref
          : await this.sessionService.getHeadStatus(head.id, snapshot);
      const runtime = await this.runtimeFactory.createFromSessionState(
        head,
        snapshot,
        this.createRuntimeCallbacks(),
        ref,
      );
      this.registry.set(head.id, {
        runtime,
        queuedInputCount: 0,
      });
    }

    this.emitChange();
    return initialized;
  }

  public getActiveAgentId(): string {
    return this.registry.getActiveAgentId();
  }

  public getBaseSystemPrompt(): string | undefined {
    return this.config.model.systemPrompt;
  }

  public getRuntimeConfig(): RuntimeConfig {
    return this.config;
  }

  public getHookStatus(): {
    fetchMemory: boolean;
    saveMemory: boolean;
    autoCompact: boolean;
  } {
    return {
      fetchMemory: this.fetchMemoryHookEnabled,
      saveMemory: this.saveMemoryHookEnabled,
      autoCompact: this.autoCompactHookEnabled,
    };
  }

  public getDebugStatus(): {
    helperAgentAutoCleanup: boolean;
    helperAgentCount: number;
    legacyAgentCount: number;
    uiContextEnabled: boolean;
  } {
    return {
      helperAgentAutoCleanup: this.helperAgentAutoCleanupEnabled,
      helperAgentCount: this.listHelperAgents().length,
      legacyAgentCount: this.listLegacyAgents().length,
      uiContextEnabled: this.registry.getActiveRuntime().isUiContextEnabled(),
    };
  }

  public setFetchMemoryHookEnabled(enabled: boolean): void {
    this.fetchMemoryHookEnabled = enabled;
    this.emitChange();
  }

  public setSaveMemoryHookEnabled(enabled: boolean): void {
    this.saveMemoryHookEnabled = enabled;
    this.emitChange();
  }

  public setAutoCompactHookEnabled(enabled: boolean): void {
    this.autoCompactHookEnabled = enabled;
    this.autoCompactFailureCountByAgent.clear();
    this.emitChange();
  }

  public setHelperAgentAutoCleanupEnabled(enabled: boolean): void {
    this.helperAgentAutoCleanupEnabled = enabled;
    this.emitChange();
  }

  public listAgents(): AgentViewState[] {
    return this.registry
      .listAgentViews()
      .filter((agent) => agent.status !== "closed")
      .sort((left, right) => {
        if (left.id === this.registry.getActiveAgentId()) {
          return -1;
        }
        if (right.id === this.registry.getActiveAgentId()) {
          return 1;
        }
        return left.name.localeCompare(right.name);
      });
  }

  public listHelperAgents(): AgentViewState[] {
    return this.listAgents().filter((agent) => Boolean(agent.helperType));
  }

  public listLegacyAgents(): AgentViewState[] {
    return this.listAgents().filter((agent) => {
      return !agent.helperType && agent.name.startsWith("legacy-");
    });
  }

  public getAgentStatus(agentId?: string): AgentViewState {
    const resolvedAgentId = agentId
      ? this.navigation.resolveAgentId(agentId)
      : this.registry.getActiveAgentId();
    const entry = this.registry.getEntry(resolvedAgentId);
    if (!entry) {
      throw new Error(`鏈壘鍒?agent锛?{resolvedAgentId}`);
    }
    return {
      ...entry.runtime.getViewState(),
      queuedInputCount: entry.queuedInputCount ?? 0,
    };
  }

  public getActiveRuntime(): HeadAgentRuntime {
    return this.registry.getActiveRuntime();
  }

  public getRuntime(agentId: string): HeadAgentRuntime {
    return this.registry.requireRuntime(agentId);
  }

  public async rebuildModelRuntime(
    config: RuntimeConfig,
    modelClient: ModelClient,
  ): Promise<void> {
    if (this.hasBusyAgents()) {
      throw new Error("请先让所有 Agent 处于空闲状态，再修改模型配置。");
    }
    this.config = config;
    this.modelClient = modelClient;
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
    const resolvedAgentId = this.navigation.resolveAgentId(agentId);
    if (options?.activate) {
      await this.navigation.switchAgent(resolvedAgentId);
    }

    return new Promise<void>((resolve, reject) => {
      const queue = this.pendingInputsByAgent.get(resolvedAgentId) ?? [];
      queue.push({
        input,
        options: {
          skipFetchMemoryHook: options?.skipFetchMemoryHook,
          approvalMode: options?.approvalMode,
        },
        resolve,
        reject,
      });
      this.pendingInputsByAgent.set(resolvedAgentId, queue);
      this.updateQueuedInputCount(resolvedAgentId);
      this.scheduleInputDrain(resolvedAgentId);
      this.emitChange();
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
    agent: AgentViewState;
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
    const agent = runtime.getViewState();
    if (checkpoint) {
      return {
        settled: "approval_required",
        agent,
        checkpoint,
        uiMessages,
      };
    }
    if (agent.status === "error") {
      return {
        settled: "error",
        agent,
        uiMessages,
      };
    }
    if (agent.status === "interrupted") {
      return {
        settled: "interrupted",
        agent,
        uiMessages,
      };
    }
    return {
      settled: "completed",
      agent,
      uiMessages,
    };
  }

  public async interruptAgent(agentId?: string): Promise<void> {
    const resolvedAgentId = agentId
      ? this.navigation.resolveAgentId(agentId)
      : this.registry.getActiveAgentId();
    await this.registry.requireRuntime(resolvedAgentId).interrupt();
  }

  public async resumeAgent(agentId?: string): Promise<void> {
    const resolvedAgentId = agentId
      ? this.navigation.resolveAgentId(agentId)
      : this.registry.getActiveAgentId();
    await this.registry.requireRuntime(resolvedAgentId).resume();
  }

  public async approvePendingRequest(
    approved: boolean,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    const resolvedAgentId = this.navigation.resolveAgentId(agentId);
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
    agent: AgentViewState;
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
    const agent = runtime.getViewState();
    if (checkpoint) {
      return {
        settled: "approval_required",
        agent,
        checkpoint,
        uiMessages,
      };
    }
    if (agent.status === "error") {
      return {
        settled: "error",
        agent,
        uiMessages,
      };
    }
    if (agent.status === "interrupted") {
      return {
        settled: "interrupted",
        agent,
        uiMessages,
      };
    }
    return {
      settled: "completed",
      agent,
      uiMessages,
    };
  }

  public async clearActiveAgentUi(): Promise<void> {
    await this.registry.getActiveRuntime().clearUiMessages();
  }

  public async recordSlashCommandOnActiveAgent(
    command: string,
    messages: ReadonlyArray<UIMessage>,
  ): Promise<void> {
    await this.registry.getActiveRuntime().recordSlashCommand(command, messages);
  }

  public async appendUiMessagesToActiveAgent(
    messages: ReadonlyArray<UIMessage>,
  ): Promise<void> {
    await this.registry.getActiveRuntime().appendUiMessages(messages);
  }

  public async setUiContextEnabled(
    enabled: boolean,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    const resolvedAgentId = this.navigation.resolveAgentId(agentId);
    const runtime = this.registry.requireRuntime(resolvedAgentId);
    await runtime.setUiContextEnabled(enabled);
    this.emitChange();
  }

  public async flushCheckpointsOnExit(): Promise<void> {
    await this.lifecycle.flushCheckpointsOnExit();
  }

  public async dispose(): Promise<void> {
    try {
      await this.lifecycle.disposeAll();
    } finally {
      await this.sessionService.dispose();
    }
  }

  public async switchAgent(agentId: string): Promise<AgentViewState> {
    return this.navigation.switchAgent(agentId);
  }

  public async switchAgentRelative(offset: number): Promise<AgentViewState> {
    return this.navigation.switchAgentRelative(offset);
  }

  public async spawnInteractiveAgent(
    options: SpawnAgentOptions,
  ): Promise<AgentViewState> {
    return this.lifecycle.spawnAgent("interactive", options);
  }

  public async spawnTaskAgent(
    options: SpawnAgentOptions,
  ): Promise<AgentViewState> {
    return this.lifecycle.spawnAgent("task", options);
  }

  public async closeAgent(agentId: string): Promise<AgentViewState> {
    return this.lifecycle.closeAgent(agentId);
  }

  public async listMemory(limit?: number): Promise<MemoryRecord[]> {
    return this.registry.getActiveRuntime().listMemory(limit);
  }

  public async saveMemory(input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }): Promise<MemoryRecord> {
    return this.registry.getActiveRuntime().saveMemory(input);
  }

  public async showMemory(name: string): Promise<MemoryRecord | undefined> {
    return this.registry.getActiveRuntime().showMemory(name);
  }

  public async getSessionGraphStatus(agentId?: string): Promise<SessionRefInfo> {
    const resolvedAgentId = agentId
      ? this.navigation.resolveAgentId(agentId)
      : this.registry.getActiveAgentId();
    const runtime = this.registry.requireRuntime(resolvedAgentId);
    const ref = runtime.getRef();
    if (ref) {
      return ref;
    }
    return this.sessionService.getHeadStatus(runtime.headId, runtime.getSnapshot());
  }

  public async listSessionRefs(): Promise<SessionListView> {
    return this.sessionService.listRefs(this.registry.getActiveRuntime().getSnapshot());
  }

  public async listSessionHeads(): Promise<SessionHeadListView> {
    return this.sessionService.listHeads(
      this.registry.getActiveRuntime().getSnapshot(),
    );
  }

  public async listSessionCommits(
    limit?: number,
  ): Promise<SessionCommitListView> {
    return this.sessionService.listCommits(
      limit,
      this.registry.getActiveRuntime().getSnapshot(),
    );
  }

  public async listSessionGraphLog(limit?: number): Promise<SessionLogEntry[]> {
    return this.sessionService.graphLog(limit);
  }

  public async listSessionLog(limit?: number): Promise<SessionLogEntry[]> {
    return this.listSessionGraphLog(limit);
  }

  public async compactSession(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<CompactSessionResult> {
    const resolvedAgentId = this.navigation.resolveAgentId(agentId);
    const runtime = this.registry.requireRuntime(resolvedAgentId);
    if (runtime.promptProfile !== "default") {
      throw new Error("只有普通对话 agent 支持 compact。");
    }
    if (runtime.isRunning()) {
      throw new Error("运行中的 agent 不能手动 compact，请先等待或中断。");
    }
    const result = await new CompactSessionService(this, this.config).run({
      targetAgentId: runtime.agentId,
      reason: "manual",
      force: true,
    });
    this.autoCompactFailureCountByAgent.delete(runtime.agentId);
    await runtime.refreshSessionState();
    this.emitChange();
    return result;
  }

  public async createSessionBranch(name: string): Promise<SessionRefInfo> {
    const runtime = this.registry.getActiveRuntime();
    const result = await this.sessionService.createBranch(
      name,
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async forkSessionBranch(name: string): Promise<SessionRefInfo> {
    const runtime = this.registry.getActiveRuntime();
    const result = await this.sessionService.forkBranch(
      name,
      runtime.getSnapshot(),
    );
    const nextRuntime = await this.runtimeFactory.createFromSessionState(
      result.head,
      result.snapshot,
      this.createRuntimeCallbacks(),
      result.ref,
    );
      this.registry.set(result.head.id, {
        runtime: nextRuntime,
        queuedInputCount: 0,
      });
      this.registry.setActiveAgentId(result.head.id);
      this.emitChange();
    return result.ref;
  }

  public async switchSessionCreateBranch(name: string): Promise<SessionRefInfo> {
    return this.forkSessionBranch(name);
  }

  public async checkoutSessionRef(ref: string): Promise<SessionCheckoutResult> {
    const runtime = this.registry.getActiveRuntime();
    const result = await this.sessionService.checkout(ref, runtime.getSnapshot());
    await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    this.emitChange();
    return result;
  }

  public async switchSessionRef(ref: string): Promise<SessionCheckoutResult> {
    return this.checkoutSessionRef(ref);
  }

  public async commitSession(message: string): Promise<SessionCommitRecord> {
    const runtime = this.registry.getActiveRuntime();
    const result = await this.sessionService.createCommit(
      message,
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.commit;
  }

  public async createSessionTag(name: string): Promise<SessionRefInfo> {
    const runtime = this.registry.getActiveRuntime();
    const result = await this.sessionService.createTag(name, runtime.getSnapshot());
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async mergeSessionRef(ref: string): Promise<SessionRefInfo> {
    const runtime = this.registry.getActiveRuntime();
    const result = await this.sessionService.merge(ref, runtime.getSnapshot());
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async forkSessionHead(name: string): Promise<SessionRefInfo> {
    const active = this.registry.getActiveRuntime();
    const result = await this.sessionService.forkHead(name, {
      sourceHeadId: active.headId,
      activate: false,
      runtimeState: {
        agentKind: "interactive",
        autoMemoryFork: true,
        retainOnCompletion: true,
      },
    });
    const runtime = await this.runtimeFactory.createFromSessionState(
      result.head,
      result.snapshot,
      this.createRuntimeCallbacks(),
      result.ref,
    );
      this.registry.set(result.head.id, {
        runtime,
        queuedInputCount: 0,
      });
      this.emitChange();
      return result.ref;
  }

  public async switchSessionHead(headId: string): Promise<SessionRefInfo> {
    const view = await this.navigation.switchAgent(headId);
    return this.sessionService.getHeadStatus(view.headId);
  }

  public async attachSessionHead(
    headId: string,
    ref: string,
  ): Promise<SessionRefInfo> {
    const resolvedHeadId = this.navigation.resolveAgentId(headId);
    const runtime = this.registry.requireRuntime(resolvedHeadId);
    const result = await this.sessionService.attachHead(
      resolvedHeadId,
      ref,
      runtime.getSnapshot(),
    );
    await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    this.emitChange();
    return result.ref;
  }

  public async detachSessionHead(headId: string): Promise<SessionRefInfo> {
    const resolvedHeadId = this.navigation.resolveAgentId(headId);
    const runtime = this.registry.requireRuntime(resolvedHeadId);
    const result = await this.sessionService.detachHead(resolvedHeadId);
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async mergeSessionHead(sourceHeadId: string): Promise<SessionRefInfo> {
    const resolvedSourceHeadId = this.navigation.resolveAgentId(sourceHeadId);
    const runtime = this.registry.getActiveRuntime();
    const result = await this.sessionService.mergeHeadIntoHead(
      runtime.headId,
      resolvedSourceHeadId,
      ["digest", "memory"],
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async closeSessionHead(headId: string): Promise<SessionRefInfo> {
    await this.lifecycle.closeAgent(headId);
    return this.sessionService.getHeadStatus(
      this.registry.getActiveAgentId(),
      this.registry.getActiveRuntime().getSnapshot(),
    );
  }

  public async cleanupCompletedAgent(agentId: string): Promise<void> {
    await this.lifecycle.cleanupCompletedAgent(agentId);
  }

  public shouldAutoCleanupHelperAgent(): boolean {
    return this.helperAgentAutoCleanupEnabled;
  }

  public async clearHelperAgents(): Promise<{
    cleared: number;
    skippedRunning: number;
  }> {
    const helperAgents = this.listHelperAgents();
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

  public async clearLegacyAgents(): Promise<{
    cleared: number;
    skippedRunning: number;
    skippedActive: number;
  }> {
    const legacyAgents = this.listLegacyAgents();
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

  private async handleRuntimeCompleted(runtime: HeadAgentRuntime): Promise<void> {
    const entry = this.registry.getEntry(runtime.agentId);
    if (!entry) {
      return;
    }

    await this.hookPipeline.handleRuntimeCompleted(runtime);

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

  private createRuntimeCallbacks(): AgentRuntimeCallbacks {
    return {
      onStateChanged: () => {
        this.emitChange();
      },
      onRunLoopCompleted: async (runtime: HeadAgentRuntime) => {
        await this.handleRuntimeCompleted(runtime);
      },
      onBeforeModelTurn: async (runtime: HeadAgentRuntime) => {
        await this.hookPipeline.handleBeforeModelTurn(runtime);
      },
      onRuntimeEvent: (event) => {
        this.emitRuntimeEvent(event);
      },
    };
  }

  private emitChange(): void {
    this.syncQueueStateWithRegistry();
    this.events.emit("change");
  }

  private scheduleInputDrain(agentId: string): void {
    if (this.inputDrainByAgent.has(agentId)) {
      return;
    }

    const drain = this.drainAgentInputQueue(agentId).finally(() => {
      this.inputDrainByAgent.delete(agentId);
      if ((this.pendingInputsByAgent.get(agentId)?.length ?? 0) > 0) {
        this.scheduleInputDrain(agentId);
      }
    });
    this.inputDrainByAgent.set(agentId, drain);
  }

  private async drainAgentInputQueue(agentId: string): Promise<void> {
    while (true) {
      const queue = this.pendingInputsByAgent.get(agentId);
      const next = queue?.[0];
      if (!queue || !next) {
        this.updateQueuedInputCount(agentId);
        this.emitChange();
        return;
      }

      this.updateQueuedInputCount(agentId);
      this.emitChange();

      try {
        const runtime = this.registry.requireRuntime(agentId);
        const modelInputAppendix = await this.hookPipeline.buildModelInputAppendix(
          runtime,
          next.input,
          next.options?.skipFetchMemoryHook,
        );
        await runtime.submitInput(next.input, {
          modelInputAppendix,
          approvalMode: next.options?.approvalMode,
        });
        next.resolve();
      } catch (error) {
        next.reject(error);
      } finally {
        queue.shift();
        if (queue.length === 0) {
          this.pendingInputsByAgent.delete(agentId);
        }
        this.updateQueuedInputCount(agentId);
        this.emitChange();
      }
    }
  }

  private updateQueuedInputCount(agentId: string): void {
    const entry = this.registry.getEntry(agentId);
    if (!entry) {
      return;
    }

    const queued = this.pendingInputsByAgent.get(agentId)?.length ?? 0;
    entry.queuedInputCount = Math.max(queued - (this.inputDrainByAgent.has(agentId) ? 1 : 0), 0);
  }

  private syncQueueStateWithRegistry(): void {
    const agentIds = new Set(this.registry.getAgentIds());
    for (const agentId of [...this.pendingInputsByAgent.keys()]) {
      if (!agentIds.has(agentId)) {
        const queue = this.pendingInputsByAgent.get(agentId) ?? [];
        for (const pending of queue) {
          pending.reject(new Error(`agent 已不存在，无法继续处理排队输入：${agentId}`));
        }
        this.pendingInputsByAgent.delete(agentId);
      }
    }
    for (const agentId of [...this.inputDrainByAgent.keys()]) {
      if (!agentIds.has(agentId)) {
        this.inputDrainByAgent.delete(agentId);
      }
    }
  }

  private emitRuntimeEvent(event: RuntimeEvent): void {
    this.events.emit("runtime-event", event);
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
      return this.registry.requireRuntime(this.navigation.resolveAgentId(input.agentId));
    }
    if (input?.headId) {
      return this.registry.getEntries().find((entry) => entry.runtime.headId === input.headId)?.runtime;
    }
    return this.registry.getEntries().find((entry) => {
      return Boolean(entry.runtime.getPendingApprovalCheckpoint());
    })?.runtime;
  }
}
