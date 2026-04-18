import type { PromptAssembler } from "../context/index.js";
import {
  projectSnapshotConversationEntries,
} from "../session/index.js";
import {
  ApprovalPolicy,
  PersistentShellSession,
  ShellTool,
  ToolRegistry,
} from "../tool/index.js";
import type {
  AgentKind,
  AgentViewState,
  ApprovalMode,
  ApprovalRequest,
  ConversationCompactedPayload,
  ConversationEntry,
  LlmMessage,
  MemoryRecord,
  ModelClient,
  PendingApprovalCheckpoint,
  PromptProfile,
  RuntimeEvent,
  RuntimeConfig,
  SessionRefInfo,
  SessionSnapshot,
  SessionWorkingHead,
  SkillManifest,
  ToolCall,
  ToolMode,
  UIMessage,
} from "../types.js";
import { createId, firstLine } from "../utils/index.js";
import { RuntimeApprovalCoordinator } from "./application/runtimeApprovalCoordinator.js";
import { RuntimeConversationProjector } from "./application/runtimeConversationProjector.js";
import { RuntimeExecutionLifecycle } from "./application/runtimeExecutionLifecycle.js";
import {
  type ApprovalHandlingMode,
  RuntimeInputQueue,
} from "./application/runtimeInputQueue.js";
import type { RuntimeSessionPort } from "./application/runtimeSessionPort.js";

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      promise,
      timeoutPromise,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export interface AgentRuntimePolicy {
  kind: AgentKind;
  autoMemoryFork: boolean;
  retainOnCompletion: boolean;
  promptProfile?: PromptProfile;
  toolMode?: ToolMode;
  approvalMode?: ApprovalMode;
  systemPrompt?: string;
  maxAgentSteps?: number;
  environment?: Record<string, string>;
}

export interface AgentRuntimeCallbacks {
  onStateChanged: (runtime: HeadAgentRuntime) => void;
  onRunLoopCompleted?: (runtime: HeadAgentRuntime) => Promise<void>;
  onBeforeModelTurn?: (runtime: HeadAgentRuntime) => Promise<void>;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
}

export interface HeadAgentRuntimeOptions {
  executorId?: string;
  config: RuntimeConfig;
  head: SessionWorkingHead;
  snapshot: SessionSnapshot;
  sessionService: RuntimeSessionPort;
  promptAssembler: PromptAssembler;
  modelClient: ModelClient;
  approvalPolicy: ApprovalPolicy;
  getAvailableSkills: () => SkillManifest[];
  policy: AgentRuntimePolicy;
  callbacks: AgentRuntimeCallbacks;
}

export class HeadAgentRuntime {
  private readonly shellTool: ShellTool;
  private readonly toolRegistry: ToolRegistry;
  private ref?: SessionRefInfo;
  private disposed = false;
  private approvalHandlingMode: ApprovalHandlingMode = "interactive";
  private readonly conversationProjector: RuntimeConversationProjector;
  private readonly approvalCoordinator: RuntimeApprovalCoordinator;
  private readonly executionLifecycle: RuntimeExecutionLifecycle;
  private readonly inputQueue: RuntimeInputQueue;
  private readonly policy: AgentRuntimePolicy;
  private readonly runtimeApprovalPolicy: ApprovalPolicy;

  public constructor(private readonly options: HeadAgentRuntimeOptions) {
    this.policy = options.policy;
    this.runtimeApprovalPolicy = this.policy.approvalMode
      ? new ApprovalPolicy(this.policy.approvalMode)
      : options.approvalPolicy;
    this.shellTool = new ShellTool(
      new PersistentShellSession(
        options.config.tool.shellExecutable,
        options.snapshot.shellCwd,
        options.policy.environment
          ? {
              ...process.env,
              ...options.policy.environment,
            }
          : undefined,
      ),
      options.config.runtime.maxToolOutputChars,
    );
    this.toolRegistry = new ToolRegistry(this.shellTool, {
      allowShell: this.policy.toolMode !== "none",
    });

    const initialStatus =
      options.head.status === "idle" && this.policy.kind === "task"
        ? "completed"
        : options.head.status;
    const initialStatusDetail =
      options.snapshot.modelMessages.length > 0 ? "会话已恢复" : "等待输入";
    const emitRuntimeEvent = (
      type: RuntimeEvent["type"],
      payload: RuntimeEvent["payload"],
    ): void => {
      this.emitRuntimeEvent(type as never, payload as never);
    };

    let executionLifecycle!: RuntimeExecutionLifecycle;
    let approvalCoordinator!: RuntimeApprovalCoordinator;
    this.conversationProjector = new RuntimeConversationProjector({
      headId: this.headId,
      sessionId: this.sessionId,
      getHead: () => this.options.head,
      setHead: (head) => {
        this.options.head = head;
      },
      getSnapshot: () => this.options.snapshot,
      setSnapshot: (snapshot) => {
        this.options.snapshot = snapshot;
      },
      getShellCwd: () => this.getShellCwd(),
      isUiContextEnabled: () => this.isUiContextEnabled(),
      sessionService: this.options.sessionService,
      refreshSessionState: async () => this.refreshSessionState(),
      getLifecycleStatus: () => executionLifecycle.getStatus(),
      onStateChanged: () => this.options.callbacks.onStateChanged(this),
    });
    approvalCoordinator = new RuntimeApprovalCoordinator({
      agentId: this.agentId,
      headId: this.headId,
      sessionId: this.sessionId,
      getShellCwd: () => this.getShellCwd(),
      getApprovalHandlingMode: () => this.approvalHandlingMode,
      setApprovalHandlingMode: (mode) => {
        this.approvalHandlingMode = mode;
      },
      sessionService: this.options.sessionService,
      setStatus: async (status, detail) => executionLifecycle.setStatus(status, detail),
      runLoop: async (input) => executionLifecycle.runLoop(input),
      executeToolCall: async (toolCall) => executionLifecycle.executeToolCall(toolCall),
      commitToolResult: async (result) => executionLifecycle.commitToolResult(result),
      onStateChanged: () => this.options.callbacks.onStateChanged(this),
      emitRuntimeEvent,
    });
    executionLifecycle = new RuntimeExecutionLifecycle(
      {
        agentId: this.agentId,
        headId: this.headId,
        sessionId: this.sessionId,
        kind: this.kind,
        promptProfile: this.promptProfile,
        policy: this.policy,
        promptAssembler: this.options.promptAssembler,
        runtimeApprovalPolicy: this.runtimeApprovalPolicy,
        toolRegistry: this.toolRegistry,
        sessionService: this.options.sessionService,
        getAvailableSkills: () => this.options.getAvailableSkills(),
        getShellCwd: () => this.getShellCwd(),
        getSnapshot: () => this.options.snapshot,
        setSnapshot: (snapshot) => {
          this.options.snapshot = snapshot;
        },
        getHead: () => this.options.head,
        setHead: (head) => {
          this.options.head = head;
        },
        setRef: (ref) => {
          this.ref = ref;
        },
        isUiContextEnabled: () => this.isUiContextEnabled(),
        conversationProjector: this.conversationProjector,
        refreshSessionState: async () => this.refreshSessionState(),
        getQueuedInputCount: () => this.inputQueue.getCount(),
        scheduleInputQueueDrain: () => this.inputQueue.scheduleDrain(),
        getApprovalHandlingMode: () => this.approvalHandlingMode,
        setApprovalHandlingMode: (mode) => {
          this.approvalHandlingMode = mode;
        },
        requestApproval: async (request, context) => {
          return approvalCoordinator.requestApproval(request, context);
        },
        onBeforeModelTurn: async () => {
          await this.options.callbacks.onBeforeModelTurn?.(this);
        },
        onRunLoopCompleted: async () => {
          await this.options.callbacks.onRunLoopCompleted?.(this);
        },
        onStateChanged: () => this.options.callbacks.onStateChanged(this),
        emitRuntimeEvent,
        clearPendingApprovalIfNeeded: (status) => {
          if (status !== "awaiting-approval") {
            approvalCoordinator.clearPendingApproval();
          }
        },
      },
      options.config,
      options.modelClient,
      initialStatus,
      initialStatusDetail,
    );
    this.executionLifecycle = executionLifecycle;
    this.approvalCoordinator = approvalCoordinator;
    this.inputQueue = new RuntimeInputQueue({
      isDisposed: () => this.disposed,
      hasPendingApproval: () => this.approvalCoordinator.hasPendingApproval(),
      isRunning: () => this.executionLifecycle.isRunning(),
      onStateChanged: () => this.options.callbacks.onStateChanged(this),
      executeQueuedInput: async (task) => this.executionLifecycle.executeQueuedInput(task),
    });
  }

  public get agentId(): string {
    return this.options.executorId ?? this.options.head.id;
  }

  public get headId(): string {
    return this.options.head.id;
  }

  public get sessionId(): string {
    return this.options.snapshot.sessionId;
  }

  public get kind(): AgentKind {
    return this.policy.kind;
  }

  public get autoMemoryFork(): boolean {
    return this.policy.autoMemoryFork;
  }

  public get retainOnCompletion(): boolean {
    return this.policy.retainOnCompletion;
  }

  public get promptProfile(): PromptProfile {
    return this.policy.promptProfile ?? "default";
  }

  public getStatus() {
    return this.executionLifecycle.getStatus();
  }

  public getStatusDetail(): string {
    return this.executionLifecycle.getStatusDetail();
  }

  public getSnapshot(): SessionSnapshot {
    return {
      ...this.options.snapshot,
    };
  }

  public getHead(): SessionWorkingHead {
    return this.options.head;
  }

  public getRef(): SessionRefInfo | undefined {
    return this.ref;
  }

  public getDraftAssistantText(): string {
    return this.executionLifecycle.getDraftAssistantText();
  }

  public getPendingApproval(): ApprovalRequest | undefined {
    return this.approvalCoordinator.getPendingApproval();
  }

  public getPendingApprovalCheckpoint(): PendingApprovalCheckpoint | undefined {
    return this.approvalCoordinator.getPendingApprovalCheckpoint();
  }

  public getQueuedInputCount(): number {
    return this.inputQueue.getCount();
  }

  public isRunning(): boolean {
    return this.executionLifecycle.isRunning();
  }

  public async initialize(initialRef?: SessionRefInfo): Promise<void> {
    this.ref =
      initialRef
      ?? await this.options.sessionService.getHeadStatus(
        this.options.head.id,
        this.options.snapshot,
      );
    const pendingCheckpoint =
      await this.options.sessionService.getPendingApprovalCheckpoint(this.headId);
    if (pendingCheckpoint) {
      this.approvalCoordinator.restoreFromCheckpoint(pendingCheckpoint);
      this.executionLifecycle.setLocalState(
        "awaiting-approval",
        firstLine(
          pendingCheckpoint.approvalRequest.summary,
          "等待审批",
        ),
        {
          clearPendingApproval: false,
        },
      );
      return;
    }
    this.options.callbacks.onStateChanged(this);
  }

  public getViewState(): AgentViewState {
    const helperType =
      this.promptProfile === "fetch-memory"
        ? "fetch-memory"
        : this.promptProfile === "auto-memory"
          ? "save-memory"
          : this.promptProfile === "compact-session"
            ? "compact-session"
          : undefined;
    return {
      id: this.agentId,
      headId: this.headId,
      sessionId: this.sessionId,
      name: this.options.head.name,
      kind: this.kind,
      helperType,
      status: this.getStatus(),
      autoMemoryFork: this.autoMemoryFork,
      retainOnCompletion: this.retainOnCompletion,
      detail: this.getStatusDetail(),
      sessionRefLabel: this.ref?.label,
      shellCwd: this.getShellCwd(),
      dirty: this.ref?.dirty ?? false,
      pendingApproval: this.getPendingApproval(),
      queuedInputCount: this.getQueuedInputCount(),
      lastUserPrompt: this.options.snapshot.lastUserPrompt,
      createdAt: this.options.head.createdAt,
      updatedAt: this.options.head.updatedAt,
    };
  }

  public async updateModelRuntime(
    config: RuntimeConfig,
    modelClient: ModelClient,
  ): Promise<void> {
    await this.executionLifecycle.updateModelRuntime(config, modelClient);
  }

  public async replaceSnapshot(
    snapshot: SessionSnapshot,
    head?: SessionWorkingHead,
    ref?: SessionRefInfo,
  ): Promise<void> {
    const nextHead = head ?? this.options.head;
    this.options.snapshot = projectSnapshotConversationEntries(
      {
        ...snapshot,
      },
      nextHead.runtimeState.uiContextEnabled ?? false,
    );
    if (head) {
      this.options.head = head;
    }
    if (ref) {
      this.ref = ref;
    }
    await this.conversationProjector.persistSnapshot();
    this.options.callbacks.onStateChanged(this);
  }

  public async seedConversation(input: {
    modelMessages?: LlmMessage[];
    uiMessages?: UIMessage[];
    lastUserPrompt?: string;
  }): Promise<void> {
    await this.conversationProjector.seedConversation(input);
  }

  public isUiContextEnabled(): boolean {
    return this.options.head.runtimeState.uiContextEnabled ?? false;
  }

  public async setUiContextEnabled(enabled: boolean): Promise<void> {
    await this.conversationProjector.setUiContextEnabled(enabled);
  }

  public async recordSlashCommand(
    command: string,
    messages: ReadonlyArray<UIMessage>,
    input?: {
      includeInModelContext?: boolean;
    },
  ): Promise<void> {
    await this.conversationProjector.recordSlashCommand(command, messages, input);
  }

  public async submitInput(
    input: string,
    options?: {
      buildModelInputAppendix?: () => Promise<string | undefined>;
      approvalMode?: ApprovalHandlingMode;
    },
  ): Promise<void> {
    await this.inputQueue.submitInput(input, options);
  }

  public async runLoop(input?: {
    startStep?: number;
    toolCalls?: ReadonlyArray<ToolCall>;
    nextToolCallIndex?: number;
    assistantMessageId?: string;
  }): Promise<void> {
    await this.executionLifecycle.runLoop(input);
  }

  public async interrupt(): Promise<void> {
    if (this.approvalCoordinator.hasPendingApproval()) {
      await this.resolveApproval(false);
    }
    this.executionLifecycle.interrupt();
  }

  public async resume(): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    await this.runLoop();
  }

  public async resolveApproval(approved: boolean): Promise<void> {
    await this.approvalCoordinator.resolveApproval(approved);
  }

  public async refreshSessionState(): Promise<void> {
    this.options.head = await this.options.sessionService.getHead(this.headId);
    this.ref = await this.options.sessionService.getHeadStatus(
      this.headId,
      this.options.snapshot,
    );
    this.options.callbacks.onStateChanged(this);
  }

  public async listMemory(limit?: number): Promise<MemoryRecord[]> {
    return this.executionLifecycle.listMemory(limit);
  }

  public async saveMemory(input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }): Promise<MemoryRecord> {
    return this.executionLifecycle.saveMemory(input);
  }

  public async showMemory(name: string): Promise<MemoryRecord | undefined> {
    return this.executionLifecycle.showMemory(name);
  }

  public async clearUiMessages(): Promise<void> {
    await this.conversationProjector.clearUiMessages();
  }

  public async resetModelContext(): Promise<{
    resetEntryCount: number;
  }> {
    return this.conversationProjector.resetModelContext();
  }

  public async appendUiMessages(
    messages: ReadonlyArray<UIMessage>,
  ): Promise<void> {
    await this.conversationProjector.appendUiMessages(messages);
  }

  public async applyCompaction(input: {
    conversationEntries: ConversationEntry[];
    summary: string;
    event: ConversationCompactedPayload;
  }): Promise<void> {
    await this.conversationProjector.applyCompaction(input);
  }

  public async markClosed(): Promise<void> {
    this.executionLifecycle.setLocalState("closed", "已关闭");
    this.inputQueue.clear();
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.inputQueue.clear();
    this.executionLifecycle.interrupt();
    await waitWithTimeout(this.executionLifecycle.waitForIdle(), 5_000);
    await this.shellTool.dispose();
  }

  public getShellCwd(): string {
    return this.shellTool.getRuntimeStatus().cwd ?? this.options.snapshot.shellCwd;
  }

  private emitRuntimeEvent<
    TType extends RuntimeEvent["type"],
  >(
    type: TType,
    payload: Extract<RuntimeEvent, { type: TType }>["payload"],
  ): void {
    this.options.callbacks.onRuntimeEvent?.({
      id: createId("event"),
      type,
      createdAt: new Date().toISOString(),
      sessionId: this.sessionId,
      worklineId: this.headId,
      executorId: this.agentId,
      headId: this.headId,
      agentId: this.agentId,
      payload,
    } as Extract<RuntimeEvent, { type: TType }>);
  }
}
