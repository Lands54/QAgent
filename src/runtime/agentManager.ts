import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  AgentKind,
  AgentViewState,
  ApprovalMode,
  LlmMessage,
  MemoryRecord,
  ModelClient,
  PromptProfile,
  RuntimeConfig,
  SessionHeadListView,
  SessionListView,
  SessionLogEntry,
  SessionRefInfo,
  SessionSnapshot,
  SessionWorkingHead,
  SkillManifest,
  ToolMode,
  UIMessage,
} from "../types.js";
import { PromptAssembler } from "../context/index.js";
import type {
  SessionCheckoutResult,
  SessionInitializationResult,
} from "../session/index.js";
import { SessionService } from "../session/index.js";
import { ApprovalPolicy } from "../tool/index.js";
import { createId } from "../utils/index.js";
import { HeadAgentRuntime } from "./agentRuntime.js";
import { AgentRuntimeFactory } from "./agentRuntimeFactory.js";
import { AutoMemoryForkService } from "./autoMemoryForkService.js";
import { CompactSessionService, type CompactSessionResult } from "./compactSessionService.js";
import { FetchMemoryService } from "./fetchMemoryService.js";

type Listener = () => void;

interface ManagedAgentEntry {
  runtime: HeadAgentRuntime;
  sourceAgentId?: string;
  mergeIntoAgentId?: string;
  mergeAssets?: string[];
  mergePending?: boolean;
}

export interface AgentManagerInitializationInput {
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
  resumeSessionId?: string;
}

export interface SpawnAgentOptions {
  name: string;
  sourceAgentId?: string;
  activate?: boolean;
  approvalMode?: ApprovalMode;
  promptProfile?: PromptProfile;
  toolMode?: ToolMode;
  seedModelMessages?: LlmMessage[];
  seedUiMessages?: UIMessage[];
  lastUserPrompt?: string;
  systemPrompt?: string;
  maxAgentSteps?: number;
  environment?: Record<string, string>;
  mergeIntoAgentId?: string;
  mergeAssets?: string[];
  autoMemoryFork?: boolean;
  retainOnCompletion?: boolean;
  buildRuntimeOverrides?: (head: SessionWorkingHead) => {
    promptProfile?: PromptProfile;
    toolMode?: ToolMode;
    systemPrompt?: string;
    maxAgentSteps?: number;
    environment?: Record<string, string>;
  };
}

function computeAutoMemoryForkSourceHash(
  snapshot: SessionSnapshot,
): string | undefined {
  if (!snapshot.lastUserPrompt || snapshot.modelMessages.length === 0) {
    return undefined;
  }

  return createHash("sha1")
    .update(
      JSON.stringify({
        lastUserPrompt: snapshot.lastUserPrompt,
        modelMessages: snapshot.modelMessages.map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.role === "tool" ? message.toolCallId : undefined,
        })),
      }),
    )
    .digest("hex");
}

export class AgentManager {
  private readonly events = new EventEmitter();
  private readonly runtimes = new Map<string, ManagedAgentEntry>();
  private readonly runtimeFactory: AgentRuntimeFactory;
  private readonly lastAutoMemoryForkSourceHashByAgent = new Map<string, string>();
  private readonly autoCompactFailureCountByAgent = new Map<string, number>();
  private fetchMemoryHookEnabled = true;
  private saveMemoryHookEnabled = true;
  private autoCompactHookEnabled = true;
  private activeAgentId = "";

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
  }

  public subscribe(listener: Listener): () => void {
    this.events.on("change", listener);
    return () => {
      this.events.off("change", listener);
    };
  }

  public async initialize(
    input: AgentManagerInitializationInput,
  ): Promise<SessionInitializationResult> {
    const initialized = await this.sessionService.initialize(input);
    this.activeAgentId = initialized.head.id;

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
      this.runtimes.set(head.id, {
        runtime,
      });
    }

    this.emitChange();
    return initialized;
  }

  public getActiveAgentId(): string {
    return this.activeAgentId;
  }

  public getBaseSystemPrompt(): string | undefined {
    return this.config.model.systemPrompt;
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

  public listAgents(): AgentViewState[] {
    return [...this.runtimes.values()]
      .map((entry) => entry.runtime.getViewState())
      .filter((agent) => agent.status !== "closed")
      .sort((left, right) => {
        if (left.id === this.activeAgentId) {
          return -1;
        }
        if (right.id === this.activeAgentId) {
          return 1;
        }
        return left.name.localeCompare(right.name);
      });
  }

  public getAgentStatus(agentId?: string): AgentViewState {
    return this.requireRuntime(
      this.resolveAgentId(agentId ?? this.activeAgentId),
    ).getViewState();
  }

  public getActiveRuntime(): HeadAgentRuntime {
    return this.requireRuntime(this.activeAgentId);
  }

  public getRuntime(agentId: string): HeadAgentRuntime {
    return this.requireRuntime(agentId);
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
    for (const entry of this.runtimes.values()) {
      await entry.runtime.updateModelRuntime(config, modelClient);
    }
    this.emitChange();
  }

  public hasBusyAgents(): boolean {
    return [...this.runtimes.values()].some((entry) => {
      const view = entry.runtime.getViewState();
      return entry.runtime.isRunning() || Boolean(view.pendingApproval);
    });
  }

  public async submitInputToActiveAgent(input: string): Promise<void> {
    await this.submitInputToAgent(this.activeAgentId, input);
  }

  public async submitInputToAgent(
    agentId: string,
    input: string,
    options?: {
      activate?: boolean;
      skipFetchMemoryHook?: boolean;
    },
  ): Promise<void> {
    if (options?.activate) {
      await this.switchAgent(agentId);
    }
    const runtime = this.requireRuntime(agentId);
    const modelInputAppendix =
      options?.skipFetchMemoryHook
      || !this.fetchMemoryHookEnabled
      || runtime.promptProfile !== "default"
        ? undefined
        : await new FetchMemoryService(this).run({
            sourceAgentId: agentId,
            userPrompt: input,
          });
    await runtime.submitInput(input, {
      modelInputAppendix,
    });
  }

  public async interruptAgent(agentId?: string): Promise<void> {
    await this.requireRuntime(agentId ?? this.activeAgentId).interrupt();
  }

  public async resumeAgent(agentId?: string): Promise<void> {
    await this.requireRuntime(agentId ?? this.activeAgentId).resume();
  }

  public async approvePendingRequest(
    approved: boolean,
    agentId = this.activeAgentId,
  ): Promise<void> {
    await this.requireRuntime(agentId).resolveApproval(approved);
  }

  public async clearActiveAgentUi(): Promise<void> {
    await this.getActiveRuntime().clearUiMessages();
  }

  public async appendUiMessagesToActiveAgent(messages: UIMessage[]): Promise<void> {
    await this.getActiveRuntime().appendUiMessages(messages);
  }

  public async flushCheckpointsOnExit(): Promise<void> {
    for (const entry of this.runtimes.values()) {
      await this.sessionService.flushCheckpointOnExit(entry.runtime.getSnapshot());
    }
  }

  public async dispose(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map(async (entry) => {
        await entry.runtime.dispose();
      }),
    );
  }

  public async switchAgent(agentId: string): Promise<AgentViewState> {
    agentId = this.resolveAgentId(agentId);
    if (agentId === this.activeAgentId) {
      return this.getAgentStatus(agentId);
    }
    const current = this.getActiveRuntime();
    const result = await this.sessionService.switchHead(
      agentId,
      current.getSnapshot(),
    );
    let runtime = this.runtimes.get(agentId)?.runtime;
    if (!runtime) {
      runtime = await this.runtimeFactory.createFromSessionState(
        result.head,
        result.snapshot,
        this.createRuntimeCallbacks(),
        result.ref,
      );
      this.runtimes.set(agentId, {
        runtime,
      });
    } else {
      await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    }
    this.activeAgentId = agentId;
    this.emitChange();
    return runtime.getViewState();
  }

  public async switchAgentRelative(offset: number): Promise<AgentViewState> {
    const agents = this.getNavigableAgents();
    if (agents.length === 0) {
      throw new Error("当前没有可切换的 agent。");
    }
    const currentIndex = agents.findIndex((agent) => agent.id === this.activeAgentId);
    if (currentIndex < 0) {
      return this.switchAgent(agents[0]!.id);
    }
    const nextIndex = (currentIndex + offset + agents.length) % agents.length;
    return this.switchAgent(agents[nextIndex]!.id);
  }

  public async spawnInteractiveAgent(
    options: SpawnAgentOptions,
  ): Promise<AgentViewState> {
    return this.spawnAgent("interactive", options);
  }

  public async spawnTaskAgent(
    options: SpawnAgentOptions,
  ): Promise<AgentViewState> {
    return this.spawnAgent("task", options);
  }

  public async closeAgent(agentId: string): Promise<AgentViewState> {
    agentId = this.resolveAgentId(agentId);
    const runtime = this.requireRuntime(agentId);
    if (agentId === this.activeAgentId) {
      throw new Error("当前 active agent 不能直接关闭。");
    }
    if (runtime.isRunning()) {
      throw new Error("运行中的 agent 不能直接关闭，请先中断。");
    }
    await this.sessionService.closeHead(agentId);
    await runtime.markClosed();
    await runtime.dispose();
    this.runtimes.delete(agentId);
    this.emitChange();
    return runtime.getViewState();
  }

  public async listMemory(limit?: number): Promise<MemoryRecord[]> {
    return this.getActiveRuntime().listMemory(limit);
  }

  public async saveMemory(input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }): Promise<MemoryRecord> {
    return this.getActiveRuntime().saveMemory(input);
  }

  public async showMemory(name: string): Promise<MemoryRecord | undefined> {
    return this.getActiveRuntime().showMemory(name);
  }

  public async getSessionGraphStatus(agentId?: string): Promise<SessionRefInfo> {
    const runtime = this.requireRuntime(agentId ?? this.activeAgentId);
    const ref = runtime.getRef();
    if (ref) {
      return ref;
    }
    return this.sessionService.getHeadStatus(runtime.headId, runtime.getSnapshot());
  }

  public async listSessionRefs(): Promise<SessionListView> {
    return this.sessionService.listRefs(this.getActiveRuntime().getSnapshot());
  }

  public async listSessionHeads(): Promise<SessionHeadListView> {
    return this.sessionService.listHeads(this.getActiveRuntime().getSnapshot());
  }

  public async listSessionLog(limit?: number): Promise<SessionLogEntry[]> {
    return this.sessionService.log(limit);
  }

  public async compactSession(agentId = this.activeAgentId): Promise<CompactSessionResult> {
    const runtime = this.requireRuntime(this.resolveAgentId(agentId));
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
    const runtime = this.getActiveRuntime();
    const result = await this.sessionService.createBranch(
      name,
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async forkSessionBranch(name: string): Promise<SessionRefInfo> {
    const runtime = this.getActiveRuntime();
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
    this.runtimes.set(result.head.id, {
      runtime: nextRuntime,
    });
    this.activeAgentId = result.head.id;
    this.emitChange();
    return result.ref;
  }

  public async checkoutSessionRef(ref: string): Promise<SessionCheckoutResult> {
    const runtime = this.getActiveRuntime();
    const result = await this.sessionService.checkout(
      ref,
      runtime.getSnapshot(),
    );
    await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    this.emitChange();
    return result;
  }

  public async createSessionTag(name: string): Promise<SessionRefInfo> {
    const runtime = this.getActiveRuntime();
    const result = await this.sessionService.createTag(
      name,
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async mergeSessionRef(ref: string): Promise<SessionRefInfo> {
    const runtime = this.getActiveRuntime();
    const result = await this.sessionService.merge(
      ref,
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async forkSessionHead(name: string): Promise<SessionRefInfo> {
    const active = this.getActiveRuntime();
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
    this.runtimes.set(result.head.id, {
      runtime,
    });
    this.emitChange();
    return result.ref;
  }

  public async switchSessionHead(headId: string): Promise<SessionRefInfo> {
    const view = await this.switchAgent(headId);
    return this.sessionService.getHeadStatus(view.headId);
  }

  public async attachSessionHead(headId: string, ref: string): Promise<SessionRefInfo> {
    const runtime = this.requireRuntime(headId);
    const result = await this.sessionService.attachHead(
      headId,
      ref,
      runtime.getSnapshot(),
    );
    await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    this.emitChange();
    return result.ref;
  }

  public async detachSessionHead(headId: string): Promise<SessionRefInfo> {
    const runtime = this.requireRuntime(headId);
    const result = await this.sessionService.detachHead(headId);
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async mergeSessionHead(sourceHeadId: string): Promise<SessionRefInfo> {
    const runtime = this.getActiveRuntime();
    const result = await this.sessionService.mergeHeadIntoHead(
      runtime.headId,
      sourceHeadId,
      ["digest", "memory"],
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async closeSessionHead(headId: string): Promise<SessionRefInfo> {
    const closed = await this.closeAgent(headId);
    return this.sessionService.getHeadStatus(this.activeAgentId, this.getActiveRuntime().getSnapshot());
  }

  public async cleanupCompletedAgent(agentId: string): Promise<void> {
    await this.closeCompletedAgent(this.resolveAgentId(agentId));
  }

  private async spawnAgent(
    kind: AgentKind,
    options: SpawnAgentOptions,
  ): Promise<AgentViewState> {
    const sourceAgentId = options.sourceAgentId ?? this.activeAgentId;
    const result = await this.sessionService.forkHead(options.name, {
      sourceHeadId: sourceAgentId,
      activate: options.activate ?? false,
      runtimeState: {
        agentKind: kind,
        autoMemoryFork: options.autoMemoryFork ?? (kind === "interactive"),
        retainOnCompletion: options.retainOnCompletion ?? true,
      },
    });
    const runtimeOverrides = options.buildRuntimeOverrides?.(result.head);
    const runtime = await this.runtimeFactory.createRuntime({
      head: result.head,
      snapshot: result.snapshot,
      initialRef: result.ref,
      policy: {
        kind,
        autoMemoryFork: options.autoMemoryFork ?? (kind === "interactive"),
        retainOnCompletion: options.retainOnCompletion ?? true,
        promptProfile: runtimeOverrides?.promptProfile ?? options.promptProfile,
        toolMode: runtimeOverrides?.toolMode ?? options.toolMode,
        approvalMode: options.approvalMode,
        systemPrompt: runtimeOverrides?.systemPrompt ?? options.systemPrompt,
        maxAgentSteps: runtimeOverrides?.maxAgentSteps ?? options.maxAgentSteps,
        environment: runtimeOverrides?.environment ?? options.environment,
      },
      callbacks: this.createRuntimeCallbacks(),
    });
    if (
      options.seedModelMessages
      || options.seedUiMessages
      || options.lastUserPrompt !== undefined
    ) {
      await runtime.seedConversation({
        modelMessages: options.seedModelMessages,
        uiMessages: options.seedUiMessages,
        lastUserPrompt: options.lastUserPrompt,
      });
    }
    this.runtimes.set(result.head.id, {
      runtime,
      sourceAgentId,
      mergeIntoAgentId: options.mergeIntoAgentId,
      mergeAssets: options.mergeAssets,
      mergePending: Boolean(options.mergeIntoAgentId),
    });
    await this.sessionService.updateHeadRuntimeState(result.head.id, {
      agentKind: kind,
      autoMemoryFork: options.autoMemoryFork ?? (kind === "interactive"),
      retainOnCompletion: options.retainOnCompletion ?? true,
      promptProfile: runtimeOverrides?.promptProfile ?? options.promptProfile,
      toolMode: runtimeOverrides?.toolMode ?? options.toolMode ?? "shell",
    });
    if (options.activate) {
      this.activeAgentId = result.head.id;
    }
    this.emitChange();
    return runtime.getViewState();
  }

  private async handleRuntimeCompleted(runtime: HeadAgentRuntime): Promise<void> {
    const entry = this.runtimes.get(runtime.agentId);
    if (!entry) {
      return;
    }

    if (
      this.saveMemoryHookEnabled
      && runtime.kind === "interactive"
      && runtime.autoMemoryFork
    ) {
      await this.runAutoMemoryForkIfNeeded(runtime.agentId);
    }

    if (
      runtime.kind === "task"
      && entry.mergeIntoAgentId
      && entry.mergePending
    ) {
      const targetRuntime = this.requireRuntime(entry.mergeIntoAgentId);
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

  private async maybeAutoCompactBeforeModelTurn(runtime: HeadAgentRuntime): Promise<void> {
    if (!this.autoCompactHookEnabled || runtime.promptProfile !== "default") {
      return;
    }
    const failureCount = this.autoCompactFailureCountByAgent.get(runtime.agentId) ?? 0;
    if (failureCount >= 3) {
      return;
    }
    try {
      const result = await new CompactSessionService(this, this.config).run({
        targetAgentId: runtime.agentId,
        reason: "auto",
        force: false,
      });
      if (result.compacted) {
        this.autoCompactFailureCountByAgent.delete(runtime.agentId);
        await runtime.refreshSessionState();
        this.emitChange();
      }
    } catch (error) {
      this.autoCompactFailureCountByAgent.set(runtime.agentId, failureCount + 1);
      await runtime.appendUiMessages([
        {
          id: createId("ui"),
          role: "error",
          content: `自动 compact 失败：${(error as Error).message}`,
          createdAt: new Date().toISOString(),
        },
      ]);
      this.emitChange();
    }
  }

  private async runAutoMemoryForkIfNeeded(agentId: string): Promise<void> {
    const runtime = this.requireRuntime(agentId);
    const snapshot = runtime.getSnapshot();
    const sourceHash = computeAutoMemoryForkSourceHash(snapshot);
    if (!sourceHash || sourceHash === this.lastAutoMemoryForkSourceHashByAgent.get(agentId)) {
      return;
    }

    const service = new AutoMemoryForkService(this);
    try {
      await service.run({
        sourceAgentId: agentId,
        targetAgentId: agentId,
        targetSnapshot: snapshot,
        availableSkills: this.getAvailableSkills(),
        lastUserPrompt: snapshot.lastUserPrompt,
        modelMessages: snapshot.modelMessages,
      });
      this.lastAutoMemoryForkSourceHashByAgent.set(agentId, sourceHash);
      await runtime.refreshSessionState();
    } catch (error) {
      await runtime.seedConversation({
        uiMessages: [
          ...snapshot.uiMessages,
          {
            id: createId("ui"),
            role: "error",
            content: `自动 memory fork 失败：${(error as Error).message}`,
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }
    this.emitChange();
  }

  private createRuntimeCallbacks() {
    return {
      onStateChanged: () => {
        this.emitChange();
      },
      onRunLoopCompleted: async (runtime: HeadAgentRuntime) => {
        await this.handleRuntimeCompleted(runtime);
      },
      onBeforeModelTurn: async (runtime: HeadAgentRuntime) => {
        await this.maybeAutoCompactBeforeModelTurn(runtime);
      },
    };
  }

  private requireRuntime(agentId: string): HeadAgentRuntime {
    const runtime = this.runtimes.get(agentId)?.runtime;
    if (!runtime) {
      throw new Error(`未找到 agent：${agentId}`);
    }
    return runtime;
  }

  private resolveAgentId(identifier: string): string {
    if (this.runtimes.has(identifier)) {
      return identifier;
    }

    const matched = [...this.runtimes.values()]
      .map((entry) => entry.runtime.getViewState())
      .filter((agent) => agent.status !== "closed" && agent.name === identifier);
    if (matched.length === 1) {
      return matched[0]!.id;
    }
    if (matched.length > 1) {
      throw new Error(`存在多个同名 agent：${identifier}，请改用 agent id。`);
    }
    throw new Error(`未找到 agent：${identifier}`);
  }

  private getNavigableAgents(): AgentViewState[] {
    return [...this.runtimes.values()]
      .map((entry) => entry.runtime.getViewState())
      .filter((agent) => agent.status !== "closed")
      .sort((left, right) => {
        const helperDiff = Number(Boolean(left.helperType)) - Number(Boolean(right.helperType));
        if (helperDiff !== 0) {
          return helperDiff;
        }
        return left.name.localeCompare(right.name);
      });
  }

  private emitChange(): void {
    this.events.emit("change");
  }

  private async closeCompletedAgent(agentId: string): Promise<void> {
    const entry = this.runtimes.get(agentId);
    if (!entry) {
      return;
    }
    const runtime = entry.runtime;
    if (runtime.isRunning()) {
      return;
    }

    if (this.activeAgentId === agentId) {
      const fallbackAgentId = this.pickFallbackAgentId(agentId, entry);
      if (!fallbackAgentId) {
        return;
      }
      await this.switchAgent(fallbackAgentId);
    }

    await this.sessionService.closeHead(agentId);
    await runtime.markClosed();
    await runtime.dispose();
    this.runtimes.delete(agentId);
    this.lastAutoMemoryForkSourceHashByAgent.delete(agentId);
    this.autoCompactFailureCountByAgent.delete(agentId);
    this.emitChange();
  }

  private pickFallbackAgentId(
    agentId: string,
    entry: ManagedAgentEntry,
  ): string | undefined {
    const preferred = [
      entry.mergeIntoAgentId,
      entry.sourceAgentId,
      ...this.getNavigableAgents()
        .map((agent) => agent.id)
        .filter((id) => id !== agentId),
    ].filter((id): id is string => Boolean(id));

    return preferred.find((id) => {
      const runtime = this.runtimes.get(id)?.runtime;
      if (!runtime) {
        return false;
      }
      return runtime.getViewState().status !== "closed";
    });
  }
}
