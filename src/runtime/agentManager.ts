import { EventEmitter } from "node:events";

import type { PromptAssembler } from "../context/index.js";
import type {
  SessionCheckoutResult,
  SessionInitializationResult,
  SessionService,
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
import { BookmarkSessionFacade } from "./application/bookmarkSessionFacade.js";
import { ExecutorService } from "./application/executorService.js";
import { HookPipeline } from "./application/hookPipeline.js";
import { RuntimeStateSyncService } from "./application/runtimeStateSyncService.js";
import { RuntimeViewProjector } from "./application/runtimeViewProjector.js";
import { WorklineService } from "./application/worklineService.js";

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
  private readonly projector: RuntimeViewProjector;
  private readonly hookPipeline: HookPipeline;
  private readonly executorService: ExecutorService;
  private readonly bookmarkSessionFacade: BookmarkSessionFacade;
  private readonly worklineService: WorklineService;
  private readonly runtimeStateSync: RuntimeStateSyncService;
  private readonly lastAutoMemoryForkSourceHashByAgent = new Map<string, string>();
  private readonly autoCompactFailureCountByAgent = new Map<string, number>();
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
    this.projector = new RuntimeViewProjector(this.registry);
    this.executorService = new ExecutorService(
      this.registry,
      this.navigation,
      this.projector,
    );
    this.bookmarkSessionFacade = new BookmarkSessionFacade(
      this.registry,
      this.navigation,
      this.runtimeFactory,
      this.lifecycle,
      this.sessionService,
      this.projector,
      () => this.createRuntimeCallbacks(),
      () => this.emitChange(),
    );
    this.worklineService = new WorklineService(
      this.registry,
      this.navigation,
      this.lifecycle,
      this.executorService,
      this.bookmarkSessionFacade,
      this.projector,
    );
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
    this.runtimeStateSync = new RuntimeStateSyncService(
      this.registry,
      this.navigation,
      this.runtimeFactory,
      this.lifecycle,
      this.hookPipeline,
      this.sessionService,
      this.projector,
      this.autoCompactFailureCountByAgent,
      () => this.emitChange(),
      (event) => this.emitRuntimeEvent(event),
      () => this.config,
      (nextConfig) => {
        this.config = nextConfig;
      },
      (nextClient) => {
        this.modelClient = nextClient;
      },
      () => this.helperAgentAutoCleanupEnabled,
    );
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
    return this.executorService.listAgents();
  }

  public listHelperAgents(): AgentViewState[] {
    return this.executorService.listHelperAgents();
  }

  public listLegacyAgents(): AgentViewState[] {
    return this.executorService.listLegacyAgents();
  }

  public getAgentStatus(agentId?: string): AgentViewState {
    return this.executorService.getAgentStatus(agentId);
  }

  public listExecutors(): ExecutorListView {
    return this.executorService.listExecutors();
  }

  public getExecutorStatus(executorId?: string): ExecutorView {
    return this.executorService.getExecutorStatus(executorId);
  }

  public listWorklines(): WorklineListView {
    return this.worklineService.listWorklines();
  }

  public getWorklineStatus(worklineId?: string): WorklineView {
    return this.worklineService.getWorklineStatus(worklineId);
  }

  public async createWorkline(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    return this.worklineService.createWorkline(name, executorId);
  }

  public async switchWorkline(
    worklineId: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    return this.worklineService.switchWorkline(worklineId, executorId);
  }

  public async switchWorklineRelative(
    offset: number,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    return this.worklineService.switchWorklineRelative(offset, executorId);
  }

  public async closeWorkline(worklineId: string): Promise<WorklineView> {
    return this.worklineService.closeWorkline(worklineId);
  }

  public async detachWorkline(worklineId?: string): Promise<WorklineView> {
    return this.worklineService.detachWorkline(worklineId);
  }

  public async mergeWorkline(
    source: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    return this.worklineService.mergeWorkline(source, executorId);
  }

  public async listBookmarks(
    executorId = this.registry.getActiveAgentId(),
  ): Promise<BookmarkListView> {
    return this.bookmarkSessionFacade.listBookmarks(executorId);
  }

  public async getBookmarkStatus(
    executorId = this.registry.getActiveAgentId(),
  ): Promise<{
    current?: string;
    bookmarks: BookmarkView[];
  }> {
    return this.bookmarkSessionFacade.getBookmarkStatus(executorId);
  }

  public async createBookmark(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.createBookmark(name, executorId);
  }

  public async createTagBookmark(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.createTagBookmark(name, executorId);
  }

  public async switchBookmark(
    bookmark: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    return this.bookmarkSessionFacade.switchBookmark(bookmark, executorId);
  }

  public async mergeBookmark(
    source: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.mergeBookmark(source, executorId);
  }

  public async interruptExecutor(executorId?: string): Promise<void> {
    await this.executorService.interruptExecutor(executorId);
  }

  public async resumeExecutor(executorId?: string): Promise<void> {
    await this.executorService.resumeExecutor(executorId);
  }

  public getActiveRuntime(): HeadAgentRuntime {
    return this.executorService.getActiveRuntime();
  }

  public getRuntime(agentId: string): HeadAgentRuntime {
    return this.executorService.getRuntime(agentId);
  }

  public getRuntimeByWorklineId(worklineId: string): HeadAgentRuntime {
    return this.executorService.getRuntimeByWorklineId(worklineId);
  }

  public async rebuildModelRuntime(
    config: RuntimeConfig,
    modelClient: ModelClient,
  ): Promise<void> {
    await this.runtimeStateSync.rebuildModelRuntime(config, modelClient);
  }

  public hasBusyAgents(): boolean {
    return this.runtimeStateSync.hasBusyAgents();
  }

  public async submitInputToActiveAgent(input: string): Promise<void> {
    await this.runtimeStateSync.submitInputToActiveAgent(input);
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
    await this.runtimeStateSync.submitInputToAgent(agentId, input, options);
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
    return this.runtimeStateSync.runAgentPrompt(input, options);
  }

  public async interruptAgent(agentId?: string): Promise<void> {
    await this.runtimeStateSync.interruptAgent(agentId);
  }

  public async resumeAgent(agentId?: string): Promise<void> {
    await this.runtimeStateSync.resumeAgent(agentId);
  }

  public async approvePendingRequest(
    approved: boolean,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    await this.runtimeStateSync.approvePendingRequest(approved, agentId);
  }

  public getPendingApprovalCheckpoint(input?: {
    checkpointId?: string;
    agentId?: string;
    headId?: string;
  }): PendingApprovalCheckpoint | undefined {
    return this.runtimeStateSync.getPendingApprovalCheckpoint(input);
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
    return this.runtimeStateSync.resolvePendingApprovalCheckpoint(approved, input);
  }

  public async clearActiveAgentUi(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    await this.runtimeStateSync.clearActiveAgentUi(agentId);
  }

  public async resetActiveAgentModelContext(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<{
    resetEntryCount: number;
  }> {
    return this.runtimeStateSync.resetActiveAgentModelContext(agentId);
  }

  public async recordSlashCommandOnActiveAgent(
    command: string,
    messages: ReadonlyArray<UIMessage>,
    agentId = this.registry.getActiveAgentId(),
    input?: {
      includeInModelContext?: boolean;
    },
  ): Promise<void> {
    await this.runtimeStateSync.recordSlashCommandOnActiveAgent(command, messages, agentId, input);
  }

  public async appendUiMessagesToActiveAgent(
    messages: ReadonlyArray<UIMessage>,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    await this.runtimeStateSync.appendUiMessagesToActiveAgent(messages, agentId);
  }

  public async setUiContextEnabled(
    enabled: boolean,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<void> {
    await this.runtimeStateSync.setUiContextEnabled(enabled, agentId);
  }

  public async flushCheckpointsOnExit(): Promise<void> {
    await this.runtimeStateSync.flushCheckpointsOnExit();
  }

  public async dispose(): Promise<void> {
    this.runtimeStateSync.dispose();
    await this.lifecycle.disposeAll();
    await this.sessionService.dispose();
  }

  public async switchAgent(agentId: string): Promise<AgentViewState> {
    return this.executorService.switchAgent(agentId);
  }

  public async switchAgentRelative(offset: number): Promise<AgentViewState> {
    return this.executorService.switchAgentRelative(offset);
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
    return this.bookmarkSessionFacade.listMemory(limit, agentId);
  }

  public async saveMemory(input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }, agentId = this.registry.getActiveAgentId()): Promise<MemoryRecord> {
    return this.bookmarkSessionFacade.saveMemory(input, agentId);
  }

  public async showMemory(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<MemoryRecord | undefined> {
    return this.bookmarkSessionFacade.showMemory(name, agentId);
  }

  public async getSessionGraphStatus(agentId?: string): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.getSessionGraphStatus(agentId);
  }

  public async listSessionRefs(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionListView> {
    return this.bookmarkSessionFacade.listSessionRefs(agentId);
  }

  public async listSessionHeads(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionHeadListView> {
    return this.bookmarkSessionFacade.listSessionHeads(agentId);
  }

  public async listSessionCommits(
    limit?: number,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCommitListView> {
    return this.bookmarkSessionFacade.listSessionCommits(limit, agentId);
  }

  public async listSessionGraphLog(limit?: number): Promise<SessionLogEntry[]> {
    return this.bookmarkSessionFacade.listSessionGraphLog(limit);
  }

  public async listSessionLog(limit?: number): Promise<SessionLogEntry[]> {
    return this.bookmarkSessionFacade.listSessionLog(limit);
  }

  public async compactSession(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<{
    compacted: boolean;
    agentId?: string;
    beforeTokens: number;
    afterTokens: number;
    keptGroups: number;
    removedGroups: number;
    summary?: string;
  }> {
    return this.runtimeStateSync.compactSession(agentId);
  }

  public async createSessionBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.createSessionBranch(name, agentId);
  }

  public async forkSessionBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.forkSessionBranch(name, agentId);
  }

  public async switchSessionCreateBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.switchSessionCreateBranch(name, agentId);
  }

  public async checkoutSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    return this.bookmarkSessionFacade.checkoutSessionRef(ref, agentId);
  }

  public async switchSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    return this.bookmarkSessionFacade.switchSessionRef(ref, agentId);
  }

  public async commitSession(
    message: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCommitRecord> {
    return this.bookmarkSessionFacade.commitSession(message, agentId);
  }

  public async createSessionTag(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.createSessionTag(name, agentId);
  }

  public async mergeSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.mergeSessionRef(ref, agentId);
  }

  public async forkSessionHead(name: string): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.forkSessionHead(name);
  }

  public async switchSessionHead(headId: string): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.switchSessionHead(headId);
  }

  public async attachSessionHead(
    headId: string,
    ref: string,
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.attachSessionHead(headId, ref);
  }

  public async detachSessionHead(headId: string): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.detachSessionHead(headId);
  }

  public async mergeSessionHead(
    sourceHeadId: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.mergeSessionHead(sourceHeadId, agentId);
  }

  public async closeSessionHead(headId: string): Promise<SessionRefInfo> {
    return this.bookmarkSessionFacade.closeSessionHead(headId);
  }

  public async cleanupCompletedAgent(agentId: string): Promise<void> {
    await this.runtimeStateSync.cleanupCompletedAgent(agentId);
  }

  public shouldAutoCleanupHelperAgent(): boolean {
    return this.helperAgentAutoCleanupEnabled;
  }

  public async clearHelperAgents(): Promise<{
    cleared: number;
    skippedRunning: number;
  }> {
    return this.runtimeStateSync.clearHelperAgents(() => this.executorService.listHelperAgents());
  }

  public async clearLegacyAgents(): Promise<{
    cleared: number;
    skippedRunning: number;
    skippedActive: number;
  }> {
    return this.runtimeStateSync.clearLegacyAgents(() => this.executorService.listLegacyAgents());
  }

  private enqueuePostRunJobs(runtime: HeadAgentRuntime): void {
    if (this.runtimeStateSync) {
      this.runtimeStateSync.enqueuePostRunJobs(runtime);
      return;
    }
    const self = this as unknown as {
      hookPipeline: {
        collectPostRunJobs(runtime: HeadAgentRuntime): Array<{
          kind: string;
          agentId: string;
          sourceHash?: string;
        }>;
      };
      pendingPostRunJobKeys: Set<string>;
      postRunJobs: Array<unknown>;
      drainingPostRunJobs: boolean;
      getPostRunJobKey(job: { kind: string; agentId: string; sourceHash?: string }): string;
      drainPostRunJobs(): Promise<void>;
    };
    for (const job of self.hookPipeline.collectPostRunJobs(runtime)) {
      const key = self.getPostRunJobKey(job);
      if (self.pendingPostRunJobKeys.has(key)) {
        continue;
      }
      self.pendingPostRunJobKeys.add(key);
      self.postRunJobs.push(job);
    }
    if (self.drainingPostRunJobs || self.postRunJobs.length === 0) {
      return;
    }
    self.drainingPostRunJobs = true;
    void self.drainPostRunJobs();
  }

  private async drainPostRunJobs(): Promise<void> {
    if (this.runtimeStateSync) {
      await this.runtimeStateSync.drainPostRunJobs();
      return;
    }
    const self = this as unknown as {
      hookPipeline: {
        runPostRunJob(job: unknown): Promise<void>;
      };
      pendingPostRunJobKeys: Set<string>;
      postRunJobs: Array<unknown>;
      drainingPostRunJobs: boolean;
      disposed: boolean;
      getPostRunJobKey(job: { kind: string; agentId: string; sourceHash?: string }): string;
      drainPostRunJobs(): Promise<void>;
      handlePostRunJobFailure(job: unknown, error: unknown): Promise<void>;
    };
    try {
      while (!self.disposed && self.postRunJobs.length > 0) {
        const job = self.postRunJobs.shift();
        if (!job) {
          continue;
        }
        try {
          await self.hookPipeline.runPostRunJob(job);
        } catch (error) {
          await self.handlePostRunJobFailure(job, error);
        } finally {
          self.pendingPostRunJobKeys.delete(
            self.getPostRunJobKey(job as { kind: string; agentId: string; sourceHash?: string }),
          );
        }
      }
    } finally {
      self.drainingPostRunJobs = false;
      if (!self.disposed && self.postRunJobs.length > 0) {
        self.drainingPostRunJobs = true;
        void self.drainPostRunJobs();
      }
    }
  }

  private async handlePostRunJobFailure(job: unknown, error: unknown): Promise<void> {
    if (this.runtimeStateSync) {
      await this.runtimeStateSync.handlePostRunJobFailure(job as never, error);
    }
  }

  private getPostRunJobKey(job: {
    kind: string;
    agentId: string;
    sourceHash?: string;
  }): string {
    if (this.runtimeStateSync) {
      return this.runtimeStateSync.getPostRunJobKey(job as never);
    }
    if (job.kind === "auto-memory-fork") {
      return `${job.kind}:${job.agentId}:${job.sourceHash}`;
    }
    return `${job.kind}:${job.agentId}`;
  }

  private createRuntimeCallbacks(): AgentRuntimeCallbacks {
    return {
      onStateChanged: () => {
        this.emitChange();
      },
      onRunLoopCompleted: async (runtime: HeadAgentRuntime) => {
        await this.runtimeStateSync.handleRuntimeCompleted(runtime);
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
}
