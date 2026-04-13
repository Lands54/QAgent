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
  BookmarkListView,
  BookmarkView,
  ExecutorListView,
  ExecutorView,
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
  WorklineListView,
  WorklineView,
} from "../types.js";
import type { AgentRuntimeCallbacks, HeadAgentRuntime } from "./agentRuntime.js";
import { AgentRuntimeFactory } from "./agentRuntimeFactory.js";
import {
  AgentLifecycleService,
  type SpawnAgentOptions,
} from "./application/agentLifecycleService.js";
import { AgentNavigationService } from "./application/agentNavigationService.js";
import { AgentRegistry } from "./application/agentRegistry.js";
import { HookPipeline, type PostRunJob } from "./application/hookPipeline.js";
import {
  CompactSessionService,
  type CompactSessionResult,
} from "./compactSessionService.js";
import { createId } from "../utils/index.js";

type Listener = () => void;
type RuntimeEventListener = (event: RuntimeEvent) => void;

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
  private readonly pendingPostRunJobKeys = new Set<string>();
  private readonly postRunJobs: PostRunJob[] = [];
  private fetchMemoryHookEnabled = true;
  private saveMemoryHookEnabled = true;
  private autoCompactHookEnabled = true;
  private helperAgentAutoCleanupEnabled = true;
  private drainingPostRunJobs = false;
  private disposed = false;

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
    let activeAgentId = "";

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
      this.registry.set(runtime.agentId, {
        runtime,
      });
      if (head.id === initialized.head.id) {
        activeAgentId = runtime.agentId;
      }
    }

    this.registry.initializeActiveAgent(activeAgentId);

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
      ? this.navigation.resolveExecutorId(agentId)
      : this.registry.getActiveAgentId();
    return this.registry.requireRuntime(resolvedAgentId).getViewState();
  }

  public listExecutors(): ExecutorListView {
    return {
      executors: this.listAgents().map((agent) => this.toExecutorView(agent)),
    };
  }

  public getExecutorStatus(executorId?: string): ExecutorView {
    return this.toExecutorView(this.getAgentStatus(executorId));
  }

  public listWorklines(): WorklineListView {
    return {
      worklines: this.listAgents()
        .filter((agent) => !agent.helperType)
        .map((agent) => this.toWorklineView(agent)),
    };
  }

  public getWorklineStatus(worklineId?: string): WorklineView {
    const resolvedWorklineId = worklineId
      ? this.navigation.resolveWorklineId(worklineId)
      : this.registry.getActiveRuntime().headId;
    return this.toWorklineView(this.registry.requireRuntimeByHeadId(resolvedWorklineId).getViewState());
  }

  public async createWorkline(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    const ref = await this.forkSessionBranch(name, executorId);
    return this.getWorklineStatus(ref.workingHeadId);
  }

  public async switchWorkline(
    worklineId: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    const resolvedExecutorId = this.navigation.resolveExecutorId(executorId);
    const agent = await this.navigation.switchWorkline(worklineId, resolvedExecutorId);
    return this.toWorklineView(agent);
  }

  public async switchWorklineRelative(
    offset: number,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    this.registry.setActiveAgentId(this.navigation.resolveExecutorId(executorId));
    const agent = await this.navigation.switchWorklineRelative(offset);
    return this.toWorklineView(agent);
  }

  public async closeWorkline(worklineId: string): Promise<WorklineView> {
    const resolvedWorklineId = this.navigation.resolveWorklineId(worklineId);
    const runtime = this.registry.requireRuntimeByHeadId(resolvedWorklineId);
    const agent = await this.closeAgent(runtime.agentId);
    const closedRuntime = this.registry.getEntryByHeadId(resolvedWorklineId)?.runtime;
    const ref = closedRuntime?.getRef();
    return {
      id: agent.headId,
      sessionId: agent.sessionId,
      name: agent.name,
      attachmentMode: ref?.mode ?? "detached-node",
      attachmentLabel: ref?.label ?? "closed",
      shellCwd: agent.shellCwd,
      dirty: agent.dirty,
      writeLock: ref?.writerLeaseBranch,
      status: agent.status,
      detail: agent.detail,
      executorKind: agent.kind,
      helperType: agent.helperType,
      pendingApproval: agent.pendingApproval,
      queuedInputCount: agent.queuedInputCount,
      lastUserPrompt: agent.lastUserPrompt,
      active: false,
    };
  }

  public async detachWorkline(worklineId?: string): Promise<WorklineView> {
    const resolvedWorklineId = worklineId
      ? this.navigation.resolveWorklineId(worklineId)
      : this.registry.getActiveRuntime().headId;
    await this.detachSessionHead(resolvedWorklineId);
    return this.getWorklineStatus(resolvedWorklineId);
  }

  public async mergeWorkline(
    source: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    await this.mergeSessionHead(source, executorId);
    return this.getWorklineStatus(undefined);
  }

  public async listBookmarks(
    executorId = this.registry.getActiveAgentId(),
  ): Promise<BookmarkListView> {
    const refs = await this.listSessionRefs(executorId);
    return {
      bookmarks: [
        ...refs.branches.map((branch) => this.toBookmarkView("branch", branch)),
        ...refs.tags.map((tag) => this.toBookmarkView("tag", tag)),
      ],
    };
  }

  public async getBookmarkStatus(
    executorId = this.registry.getActiveAgentId(),
  ): Promise<{
    current?: string;
    bookmarks: BookmarkView[];
  }> {
    const current = await this.getSessionGraphStatus(executorId);
    const bookmarks = await this.listBookmarks(executorId);
    return {
      current: current.label,
      bookmarks: bookmarks.bookmarks,
    };
  }

  public async createBookmark(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.createSessionBranch(name, executorId);
  }

  public async createTagBookmark(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.createSessionTag(name, executorId);
  }

  public async switchBookmark(
    bookmark: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    return this.switchSessionRef(bookmark, executorId);
  }

  public async mergeBookmark(
    source: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.mergeSessionRef(source, executorId);
  }

  public async interruptExecutor(executorId?: string): Promise<void> {
    await this.interruptAgent(executorId);
  }

  public async resumeExecutor(executorId?: string): Promise<void> {
    await this.resumeAgent(executorId);
  }

  public getActiveRuntime(): HeadAgentRuntime {
    return this.registry.getActiveRuntime();
  }

  public getRuntime(agentId: string): HeadAgentRuntime {
    return this.registry.requireRuntime(agentId);
  }

  public getRuntimeByWorklineId(worklineId: string): HeadAgentRuntime {
    return this.registry.requireRuntimeByHeadId(
      this.navigation.resolveWorklineId(worklineId),
    );
  }

  private toExecutorView(agent: AgentViewState): ExecutorView {
    return {
      ...agent,
      executorId: agent.id,
      worklineId: agent.headId,
      worklineName: agent.name,
      active: agent.id === this.registry.getActiveAgentId(),
    };
  }

  private toWorklineView(agent: AgentViewState): WorklineView {
    const runtime = this.registry.requireRuntime(agent.id);
    const ref = runtime.getRef();
    return {
      id: agent.headId,
      sessionId: agent.sessionId,
      name: agent.name,
      attachmentMode: ref?.mode ?? "detached-node",
      attachmentLabel: ref?.label ?? "detached",
      shellCwd: agent.shellCwd,
      dirty: agent.dirty,
      writeLock: ref?.writerLeaseBranch,
      status: agent.status,
      detail: agent.detail,
      executorKind: agent.kind,
      helperType: agent.helperType,
      pendingApproval: agent.pendingApproval,
      queuedInputCount: agent.queuedInputCount,
      lastUserPrompt: agent.lastUserPrompt,
      active: runtime.headId === this.registry.getActiveRuntime().headId,
    };
  }

  private toBookmarkView(
    kind: "branch" | "tag",
    item: SessionListView["branches"][number],
  ): BookmarkView {
    return {
      name: item.name,
      kind,
      targetNodeId: item.targetNodeId,
      current: item.current,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
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
    executor: ExecutorView;
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
    const executor = this.toExecutorView(runtime.getViewState());
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
    executor: ExecutorView;
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
    const executor = this.toExecutorView(runtime.getViewState());
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

  public async flushCheckpointsOnExit(): Promise<void> {
    await this.lifecycle.flushCheckpointsOnExit();
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.postRunJobs.length = 0;
    this.pendingPostRunJobKeys.clear();
    await this.lifecycle.disposeAll();
    await this.sessionService.dispose();
  }

  public async switchAgent(agentId: string): Promise<AgentViewState> {
    return this.navigation.switchExecutor(agentId);
  }

  public async switchAgentRelative(offset: number): Promise<AgentViewState> {
    return this.navigation.switchWorklineRelative(offset);
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

  public async listMemory(
    limit?: number,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<MemoryRecord[]> {
    return this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId)).listMemory(limit);
  }

  public async saveMemory(input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }, agentId = this.registry.getActiveAgentId()): Promise<MemoryRecord> {
    return this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId)).saveMemory(input);
  }

  public async showMemory(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<MemoryRecord | undefined> {
    return this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId)).showMemory(name);
  }

  public async getSessionGraphStatus(agentId?: string): Promise<SessionRefInfo> {
    const resolvedAgentId = agentId
      ? this.navigation.resolveExecutorId(agentId)
      : this.registry.getActiveAgentId();
    const runtime = this.registry.requireRuntime(resolvedAgentId);
    const ref = runtime.getRef();
    if (ref) {
      return ref;
    }
    return this.sessionService.getHeadStatus(runtime.headId, runtime.getSnapshot());
  }

  public async listSessionRefs(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionListView> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    return this.sessionService.listRefs(runtime.getSnapshot());
  }

  public async listSessionHeads(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionHeadListView> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    return this.sessionService.listHeads(
      runtime.getSnapshot(),
    );
  }

  public async listSessionCommits(
    limit?: number,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCommitListView> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    return this.sessionService.listCommits(
      limit,
      runtime.getSnapshot(),
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
    const resolvedAgentId = this.navigation.resolveExecutorId(agentId);
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

  public async createSessionBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.createBranch(
      name,
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async forkSessionBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
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
    this.registry.set(nextRuntime.agentId, {
      runtime: nextRuntime,
    });
    this.registry.setActiveAgentId(nextRuntime.agentId);
    this.emitChange();
    return result.ref;
  }

  public async switchSessionCreateBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.forkSessionBranch(name, agentId);
  }

  public async checkoutSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.checkout(ref, runtime.getSnapshot());
    await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    this.emitChange();
    return result;
  }

  public async switchSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    return this.checkoutSessionRef(ref, agentId);
  }

  public async commitSession(
    message: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCommitRecord> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.createCommit(
      message,
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.commit;
  }

  public async createSessionTag(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.createTag(name, runtime.getSnapshot());
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async mergeSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
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
    this.registry.set(runtime.agentId, {
      runtime,
    });
    this.emitChange();
    return result.ref;
  }

  public async switchSessionHead(headId: string): Promise<SessionRefInfo> {
    const view = await this.navigation.switchWorkline(headId);
    return this.sessionService.getHeadStatus(view.headId);
  }

  public async attachSessionHead(
    headId: string,
    ref: string,
  ): Promise<SessionRefInfo> {
    const resolvedHeadId = this.navigation.resolveWorklineId(headId);
    const runtime = this.registry.requireRuntimeByHeadId(resolvedHeadId);
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
    const resolvedHeadId = this.navigation.resolveWorklineId(headId);
    const runtime = this.registry.requireRuntimeByHeadId(resolvedHeadId);
    const result = await this.sessionService.detachHead(resolvedHeadId);
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async mergeSessionHead(
    sourceHeadId: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const resolvedSourceHeadId = this.navigation.resolveWorklineId(sourceHeadId);
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
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
    const runtime = this.registry.requireRuntimeByHeadId(
      this.navigation.resolveWorklineId(headId),
    );
    await this.lifecycle.closeAgent(runtime.agentId);
    return this.sessionService.getHeadStatus(
      this.registry.getActiveRuntime().headId,
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
    this.events.emit("change");
  }

  private emitRuntimeEvent(event: RuntimeEvent): void {
    this.events.emit("runtime-event", event);
  }

  private enqueuePostRunJobs(runtime: HeadAgentRuntime): void {
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

  private async drainPostRunJobs(): Promise<void> {
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

  private async handlePostRunJobFailure(
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

  private getPostRunJobKey(job: PostRunJob): string {
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
