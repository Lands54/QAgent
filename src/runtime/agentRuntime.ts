import type {
  AgentKind,
  AgentLifecycleStatus,
  AgentViewState,
  ApprovalMode,
  ApprovalDecision,
  ApprovalRequest,
  LlmMessage,
  MemoryRecord,
  ModelClient,
  PromptProfile,
  RuntimeConfig,
  SessionRefInfo,
  SessionSnapshot,
  SessionWorkingHead,
  SkillManifest,
  ToolCall,
  ToolMode,
  UIMessage,
} from "../types.js";
import { PromptAssembler } from "../context/index.js";
import { MemoryService } from "../memory/index.js";
import { SessionService } from "../session/index.js";
import {
  ApprovalPolicy,
  PersistentShellSession,
  ShellTool,
  ToolRegistry,
  formatToolResultForModel,
} from "../tool/index.js";
import { createId, firstLine, formatDuration } from "../utils/index.js";
import { AgentRunner } from "./agentRunner.js";

interface PendingApprovalState {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
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
}

export interface HeadAgentRuntimeOptions {
  config: RuntimeConfig;
  head: SessionWorkingHead;
  snapshot: SessionSnapshot;
  sessionService: SessionService;
  promptAssembler: PromptAssembler;
  modelClient: ModelClient;
  approvalPolicy: ApprovalPolicy;
  getAvailableSkills: () => SkillManifest[];
  policy: AgentRuntimePolicy;
  callbacks: AgentRuntimeCallbacks;
}

function mapLifecycleStatusToHeadStatus(
  status: AgentLifecycleStatus,
): SessionWorkingHead["status"] {
  if (status === "booting" || status === "completed") {
    return "idle";
  }
  if (status === "closed") {
    return "closed";
  }
  return status;
}

function buildToolUiMessage(result: Parameters<HeadAgentRuntime["commitToolResult"]>[0]): UIMessage {
  return {
    id: createId("ui"),
    role: result.status === "success" ? "tool" : "error",
    content: [
      `$ ${result.command}`,
      `status=${result.status} exit=${result.exitCode ?? "null"} cwd=${result.cwd} duration=${formatDuration(result.durationMs)}`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    createdAt: new Date().toISOString(),
    title: "Shell Tool",
  };
}

export class HeadAgentRuntime {
  private readonly shellTool: ShellTool;
  private readonly toolRegistry: ToolRegistry;
  private agentRunner: AgentRunner;
  private ref?: SessionRefInfo;
  private draftAssistantText = "";
  private status: AgentLifecycleStatus;
  private statusDetail: string;
  private pendingApproval?: PendingApprovalState;
  private disposed = false;
  private config: RuntimeConfig;
  private modelClient: ModelClient;
  private readonly policy: AgentRuntimePolicy;
  private readonly runtimeApprovalPolicy: ApprovalPolicy;

  public constructor(private readonly options: HeadAgentRuntimeOptions) {
    this.config = options.config;
    this.modelClient = options.modelClient;
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
    this.status =
      options.head.status === "idle" && this.policy.kind === "task"
        ? "completed"
        : options.head.status;
    this.statusDetail =
      options.snapshot.modelMessages.length > 0 ? "会话已恢复" : "等待输入";
    this.agentRunner = this.createRunner();
  }

  public get agentId(): string {
    return this.options.head.id;
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

  public getStatus(): AgentLifecycleStatus {
    return this.status;
  }

  public getStatusDetail(): string {
    return this.statusDetail;
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
    return this.draftAssistantText;
  }

  public getPendingApproval(): ApprovalRequest | undefined {
    return this.pendingApproval?.request;
  }

  public isRunning(): boolean {
    return this.agentRunner.isRunning();
  }

  public async initialize(initialRef?: SessionRefInfo): Promise<void> {
    this.ref =
      initialRef
      ?? await this.options.sessionService.getHeadStatus(
        this.options.head.id,
        this.options.snapshot,
      );
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
      status: this.status,
      autoMemoryFork: this.autoMemoryFork,
      retainOnCompletion: this.retainOnCompletion,
      detail: this.statusDetail,
      sessionRefLabel: this.ref?.label,
      shellCwd: this.getShellCwd(),
      dirty: this.ref?.dirty ?? false,
      pendingApproval: this.pendingApproval?.request,
      lastUserPrompt: this.options.snapshot.lastUserPrompt,
      createdAt: this.options.head.createdAt,
      updatedAt: this.options.head.updatedAt,
    };
  }

  public async updateModelRuntime(
    config: RuntimeConfig,
    modelClient: ModelClient,
  ): Promise<void> {
    if (this.isRunning()) {
      throw new Error(`Agent 正在运行，无法更新模型：${this.options.head.name}`);
    }
    this.config = config;
    this.modelClient = modelClient;
    this.agentRunner = this.createRunner();
    this.options.callbacks.onStateChanged(this);
  }

  public async replaceSnapshot(
    snapshot: SessionSnapshot,
    head?: SessionWorkingHead,
    ref?: SessionRefInfo,
  ): Promise<void> {
    this.options.snapshot = {
      ...snapshot,
    };
    if (head) {
      this.options.head = head;
    }
    if (ref) {
      this.ref = ref;
    }
    await this.persistSnapshot();
    this.options.callbacks.onStateChanged(this);
  }

  public async seedConversation(input: {
    modelMessages?: LlmMessage[];
    uiMessages?: UIMessage[];
    lastUserPrompt?: string;
  }): Promise<void> {
    if (input.modelMessages) {
      this.options.snapshot.modelMessages = [...input.modelMessages];
    }
    if (input.uiMessages) {
      this.options.snapshot.uiMessages = [...input.uiMessages];
    }
    if (input.lastUserPrompt !== undefined) {
      this.options.snapshot.lastUserPrompt = input.lastUserPrompt;
    }
    this.options.snapshot.updatedAt = new Date().toISOString();
    await this.persistSnapshot();
    this.options.callbacks.onStateChanged(this);
  }

  public async submitInput(
    input: string,
    options?: {
      modelInputAppendix?: string;
    },
  ): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    if (this.isRunning()) {
      await this.addUiMessage({
        id: createId("ui"),
        role: "error",
        content: "Agent 正在执行中。可先中断，再提交新任务。",
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const autoBranch = await this.options.sessionService.prepareHeadForUserInput(
      this.headId,
      this.options.snapshot,
    );
    if (autoBranch) {
      this.options.head = autoBranch.head;
      this.ref = autoBranch.ref;
      await this.addUiMessage({
        id: createId("ui"),
        role: "info",
        content: autoBranch.message,
        createdAt: new Date().toISOString(),
      });
    }

    const now = new Date().toISOString();
    const modelInput = this.buildModelUserInput(
      trimmed,
      now,
      options?.modelInputAppendix,
    );
    await this.addUiMessage({
      id: createId("ui"),
      role: "user",
      content: trimmed,
      createdAt: now,
    });
    await this.addModelMessage({
      id: createId("llm"),
      role: "user",
      content: modelInput,
      createdAt: now,
    });
    this.options.snapshot.lastUserPrompt = trimmed;
    await this.persistEvent("last_user_prompt.set", {
      prompt: trimmed,
    });
    await this.persistSnapshot();

    await this.runLoop();
  }

  public async runLoop(): Promise<void> {
    await this.agentRunner.runLoop();
  }

  public async interrupt(): Promise<void> {
    if (this.pendingApproval) {
      await this.resolveApproval(false);
    }
    this.agentRunner.interrupt();
  }

  public async resume(): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    await this.runLoop();
  }

  public async resolveApproval(approved: boolean): Promise<void> {
    if (!this.pendingApproval) {
      return;
    }
    const pending = this.pendingApproval;
    this.pendingApproval = undefined;
    this.status = approved ? "running" : "interrupted";
    this.statusDetail = approved ? "审批已通过，继续执行" : "审批已拒绝";
    this.options.callbacks.onStateChanged(this);
    pending.resolve({
      requestId: pending.request.id,
      approved,
      decidedAt: new Date().toISOString(),
    });
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
    return (await this.getMemoryService()).list(limit);
  }

  public async saveMemory(input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }): Promise<MemoryRecord> {
    return (await this.getMemoryService()).save(input);
  }

  public async showMemory(name: string): Promise<MemoryRecord | undefined> {
    return (await this.getMemoryService()).show(name);
  }

  public async clearUiMessages(): Promise<void> {
    this.options.snapshot.uiMessages = [];
    this.options.snapshot.updatedAt = new Date().toISOString();
    await this.persistEvent("ui.cleared", {});
    await this.persistSnapshot();
    this.options.callbacks.onStateChanged(this);
  }

  public async appendUiMessages(messages: UIMessage[]): Promise<void> {
    for (const message of messages) {
      await this.addUiMessage(message);
    }
  }

  public async applyCompaction(input: {
    modelMessages: LlmMessage[];
    summary: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    this.options.snapshot.modelMessages = [...input.modelMessages];
    this.options.snapshot.lastRunSummary = input.summary;
    this.options.snapshot.updatedAt = new Date().toISOString();
    await this.persistEvent("session.compacted", input.metadata);
    await this.persistSnapshot();
    await this.options.sessionService.flushCompactSnapshot(this.options.snapshot);
    await this.refreshSessionState();
    this.options.callbacks.onStateChanged(this);
  }

  public async markClosed(): Promise<void> {
    this.status = "closed";
    this.statusDetail = "已关闭";
    this.pendingApproval = undefined;
    this.options.callbacks.onStateChanged(this);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.shellTool.dispose();
  }

  private createRunner(): AgentRunner {
    return new AgentRunner({
      config: this.buildRuntimeConfig(),
      promptAssembler: this.options.promptAssembler,
      promptProfile: this.policy.promptProfile ?? "default",
      toolMode: this.policy.toolMode ?? "shell",
      modelClient: this.modelClient,
      toolRegistry: this.toolRegistry,
      approvalPolicy: this.runtimeApprovalPolicy,
      getModelMessages: () => this.options.snapshot.modelMessages,
      getAvailableSkills: () => this.options.getAvailableSkills(),
      getShellCwd: () => this.getShellCwd(),
      getLastUserPrompt: () => this.options.snapshot.lastUserPrompt,
      beforeModelTurn: async () => {
        await this.options.callbacks.onBeforeModelTurn?.(this);
      },
      searchRelevantMemory: async (query) =>
        (await this.getMemoryService()).search(query, 5),
      commitAssistantTurn: async ({ content, toolCalls }) =>
        this.commitAssistantTurn({ content, toolCalls }),
      commitToolResult: async (result) => this.commitToolResult(result),
      emitInfo: async (message) => {
        await this.addUiMessage({
          id: createId("ui"),
          role: "info",
          content: message,
          createdAt: new Date().toISOString(),
        });
      },
      emitError: async (message) => {
        await this.addUiMessage({
          id: createId("ui"),
          role: "error",
          content: message,
          createdAt: new Date().toISOString(),
        });
      },
      setStatus: async (mode, detail) => {
        if (mode === "idle") {
          const nextStatus = this.kind === "task" ? "completed" : "idle";
          const nextDetail = this.kind === "task" ? "任务已完成" : detail;
          await this.setStatusInternal(nextStatus, nextDetail);
          await this.options.sessionService.flushCheckpointIfDirty(
            this.options.snapshot,
          );
          await this.refreshSessionState();
          if (this.options.callbacks.onRunLoopCompleted) {
            await this.options.callbacks.onRunLoopCompleted(this);
            await this.refreshSessionState();
          }
          return;
        }
        await this.setStatusInternal(mode, detail);
      },
      startAssistantDraft: async () => {
        this.draftAssistantText = "";
        this.options.callbacks.onStateChanged(this);
      },
      pushAssistantDraft: async (delta) => {
        this.draftAssistantText = `${this.draftAssistantText}${delta}`;
        this.options.callbacks.onStateChanged(this);
      },
      finishAssistantDraft: async () => {
        this.draftAssistantText = "";
        this.options.callbacks.onStateChanged(this);
      },
      requestApproval: async (request) => this.requestApproval(request),
    });
  }

  private buildRuntimeConfig(): RuntimeConfig {
    return {
      ...this.config,
      model: {
        ...this.config.model,
        systemPrompt: this.policy.systemPrompt ?? this.config.model.systemPrompt,
      },
      runtime: {
        ...this.config.runtime,
        maxAgentSteps:
          this.policy.maxAgentSteps ?? this.config.runtime.maxAgentSteps,
      },
    };
  }

  private buildModelUserInput(
    input: string,
    now: string,
    appendix?: string,
  ): string {
    const normalizedAppendix = appendix?.trim();
    if (this.promptProfile !== "default") {
      return normalizedAppendix ? `${input}\n\n${normalizedAppendix}` : input;
    }

    const sections = [
      `当前时间：${now}`,
      `当前 shell 工作目录：${this.getShellCwd()}`,
      `当前工具审批模式：${this.runtimeApprovalPolicy.getMode()}`,
      `当前最大自治步数：${this.buildRuntimeConfig().runtime.maxAgentSteps}`,
      "",
      input,
    ];
    if (normalizedAppendix) {
      sections.push("", normalizedAppendix);
    }
    return sections.join("\n");
  }

  private async getMemoryService(): Promise<MemoryService> {
    const state = this.options.head.assetState.memory as
      | {
          projectMemoryDir?: string;
          globalMemoryDir?: string;
        }
      | undefined;
    if (!state?.projectMemoryDir || !state?.globalMemoryDir) {
      throw new Error(`agent ${this.options.head.name} 缺少 memory asset state。`);
    }
    return new MemoryService({
      projectMemoryDir: state.projectMemoryDir,
      globalMemoryDir: state.globalMemoryDir,
    });
  }

  private getShellCwd(): string {
    return this.shellTool.getRuntimeStatus().cwd ?? this.options.snapshot.shellCwd;
  }

  private async requestApproval(
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    this.pendingApproval = undefined;
    await this.setStatusInternal(
      "awaiting-approval",
      firstLine(request.summary, "等待审批"),
    );
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = {
        request,
        resolve,
      };
      this.options.callbacks.onStateChanged(this);
    });
  }

  private async commitAssistantTurn(input: {
    content: string;
    toolCalls: ToolCall[];
  }): Promise<void> {
    if (!input.content && input.toolCalls.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    await this.addModelMessage({
      id: createId("llm"),
      role: "assistant",
      content: input.content,
      toolCalls: input.toolCalls.length > 0 ? input.toolCalls : undefined,
      createdAt: now,
    });

    if (input.content.trim()) {
      await this.addUiMessage({
        id: createId("ui"),
        role: "assistant",
        content: input.content,
        createdAt: now,
      });
    }
  }

  private async commitToolResult(result: {
    callId: string;
    name: "shell";
    command: string;
    status: "success" | "error" | "rejected" | "timeout" | "cancelled";
    exitCode: number | null;
    stdout: string;
    stderr: string;
    cwd: string;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
  }): Promise<void> {
    await this.addModelMessage({
      id: createId("llm"),
      role: "tool",
      name: "shell",
      toolCallId: result.callId,
      content: formatToolResultForModel(result),
      createdAt: new Date().toISOString(),
    });
    this.options.snapshot.shellCwd = result.cwd;
    await this.addUiMessage(buildToolUiMessage(result));
  }

  private async setStatusInternal(
    status: AgentLifecycleStatus,
    detail: string,
  ): Promise<void> {
    this.status = status;
    this.statusDetail = detail;
    if (status !== "awaiting-approval") {
      this.pendingApproval = undefined;
    }
    await this.persistEvent("status.set", {
      mode: status,
      detail,
    });
    await this.persistSnapshot();
    this.options.callbacks.onStateChanged(this);
  }

  private async addUiMessage(message: UIMessage): Promise<void> {
    this.options.snapshot.uiMessages = [...this.options.snapshot.uiMessages, message];
    this.options.snapshot.updatedAt = new Date().toISOString();
    await this.persistEvent("ui.message.add", {
      message,
    });
    await this.persistSnapshot();
    this.options.callbacks.onStateChanged(this);
  }

  private async addModelMessage(message: LlmMessage): Promise<void> {
    this.options.snapshot.modelMessages = [
      ...this.options.snapshot.modelMessages,
      message,
    ];
    this.options.snapshot.updatedAt = new Date().toISOString();
    await this.persistEvent("model.message.add", {
      message,
    });
    await this.persistSnapshot();
    this.options.callbacks.onStateChanged(this);
  }

  private async persistEvent(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.options.sessionService.persistWorkingEvent({
      id: createId("event"),
      workingHeadId: this.headId,
      sessionId: this.sessionId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    });
  }

  private async persistSnapshot(): Promise<void> {
    this.options.snapshot = {
      ...this.options.snapshot,
      workingHeadId: this.headId,
      sessionId: this.options.head.sessionId,
      shellCwd: this.getShellCwd(),
      updatedAt: new Date().toISOString(),
    };
    await this.options.sessionService.persistWorkingSnapshot(
      this.options.snapshot,
      mapLifecycleStatusToHeadStatus(this.status),
    );
  }
}
