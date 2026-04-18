import { AgentRunner } from "../agentRunner.js";
import { MemoryService } from "../../memory/index.js";
import {
  createAgentStatusSetEvent,
  createConversationEntry,
  createConversationLastUserPromptSetEvent,
  projectSnapshotConversationEntries,
} from "../../session/index.js";
import type { PromptAssembler } from "../../context/index.js";
import type { ApprovalPolicy, ToolRegistry } from "../../tool/index.js";
import { formatToolResultForModel } from "../../tool/index.js";
import type {
  AgentKind,
  AgentLifecycleStatus,
  ApprovalDecision,
  ApprovalRequest,
  MemoryRecord,
  ModelClient,
  PromptProfile,
  RuntimeConfig,
  RuntimeEvent,
  SessionRefInfo,
  SessionSnapshot,
  SessionWorkingHead,
  SkillManifest,
  ToolCall,
  ToolMode,
  UIMessage,
} from "../../types.js";
import { createId, formatDuration } from "../../utils/index.js";
import type { ApprovalHandlingMode, QueuedInputTask } from "./runtimeInputQueue.js";
import type { RuntimeConversationProjector } from "./runtimeConversationProjector.js";
import type { RuntimeSessionPort } from "./runtimeSessionPort.js";

function buildToolUiMessage(result: Parameters<RuntimeExecutionLifecycle["commitToolResult"]>[0]): UIMessage {
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

interface RuntimeExecutionLifecycleDeps {
  agentId: string;
  headId: string;
  sessionId: string;
  kind: AgentKind;
  promptProfile: PromptProfile;
  policy: {
    promptProfile?: PromptProfile;
    toolMode?: ToolMode;
    systemPrompt?: string;
    maxAgentSteps?: number;
  };
  promptAssembler: PromptAssembler;
  runtimeApprovalPolicy: ApprovalPolicy;
  toolRegistry: ToolRegistry;
  sessionService: RuntimeSessionPort;
  getAvailableSkills: () => SkillManifest[];
  getShellCwd(): string;
  getSnapshot(): SessionSnapshot;
  setSnapshot(snapshot: SessionSnapshot): void;
  getHead(): SessionWorkingHead;
  setHead(head: SessionWorkingHead): void;
  setRef(ref: SessionRefInfo | undefined): void;
  isUiContextEnabled(): boolean;
  conversationProjector: RuntimeConversationProjector;
  refreshSessionState(): Promise<void>;
  getQueuedInputCount(): number;
  scheduleInputQueueDrain(): void;
  getApprovalHandlingMode(): ApprovalHandlingMode;
  setApprovalHandlingMode(mode: ApprovalHandlingMode): void;
  requestApproval(
    request: ApprovalRequest,
    context: {
      step: number;
      assistantMessageId: string;
      toolCalls: ReadonlyArray<ToolCall>;
      nextToolCallIndex: number;
    },
  ): Promise<ApprovalDecision>;
  onBeforeModelTurn?: () => Promise<void>;
  onRunLoopCompleted?: () => Promise<void>;
  onStateChanged(): void;
  emitRuntimeEvent<
    TType extends RuntimeEvent["type"],
  >(
    type: TType,
    payload: Extract<RuntimeEvent, { type: TType }>["payload"],
  ): void;
  clearPendingApprovalIfNeeded(status: AgentLifecycleStatus): void;
}

export class RuntimeExecutionLifecycle {
  private agentRunner: AgentRunner;
  private draftAssistantText = "";

  public constructor(
    private readonly deps: RuntimeExecutionLifecycleDeps,
    private config: RuntimeConfig,
    private modelClient: ModelClient,
    private status: AgentLifecycleStatus,
    private statusDetail: string,
  ) {
    this.agentRunner = this.createRunner();
  }

  public getStatus(): AgentLifecycleStatus {
    return this.status;
  }

  public getStatusDetail(): string {
    return this.statusDetail;
  }

  public getDraftAssistantText(): string {
    return this.draftAssistantText;
  }

  public setLocalState(
    status: AgentLifecycleStatus,
    detail: string,
    input?: {
      clearPendingApproval?: boolean;
    },
  ): void {
    this.status = status;
    this.statusDetail = detail;
    if (input?.clearPendingApproval !== false) {
      this.deps.clearPendingApprovalIfNeeded(status);
    }
    this.deps.onStateChanged();
  }

  public isRunning(): boolean {
    return this.agentRunner.isRunning();
  }

  public async waitForIdle(): Promise<void> {
    await this.agentRunner.waitForIdle();
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

  public async updateModelRuntime(
    config: RuntimeConfig,
    modelClient: ModelClient,
  ): Promise<void> {
    if (this.isRunning() || this.deps.getQueuedInputCount() > 0) {
      throw new Error(`Agent 正在运行，无法更新模型：${this.deps.getHead().name}`);
    }
    this.config = config;
    this.modelClient = modelClient;
    this.agentRunner = this.createRunner();
    this.deps.onStateChanged();
  }

  public async runLoop(input?: {
    startStep?: number;
    toolCalls?: ReadonlyArray<ToolCall>;
    nextToolCallIndex?: number;
    assistantMessageId?: string;
  }): Promise<void> {
    await this.agentRunner.runLoop(input);
    this.deps.scheduleInputQueueDrain();
  }

  public interrupt(): void {
    this.agentRunner.interrupt();
  }

  public async executeQueuedInput(task: QueuedInputTask): Promise<void> {
    const now = new Date().toISOString();
    const modelMessageId = createId("llm");
    const modelInput = this.buildModelUserInput(task.input, now);
    await this.deps.conversationProjector.appendConversationEntry(
      createConversationEntry({
        kind: "user-input",
        createdAt: now,
        ui: {
          id: createId("ui"),
          role: "user",
          content: task.input,
          createdAt: now,
        },
        model: {
          id: modelMessageId,
          role: "user",
          content: modelInput,
          createdAt: now,
        },
      }),
    );
    this.deps.setSnapshot({
      ...this.deps.getSnapshot(),
      lastUserPrompt: task.input,
    });
    await this.deps.conversationProjector.persistEvent(
      createConversationLastUserPromptSetEvent({
        workingHeadId: this.deps.headId,
        sessionId: this.deps.sessionId,
        prompt: task.input,
      }),
    );
    await this.deps.conversationProjector.persistSnapshot();

    const autoBranch = await this.deps.sessionService.prepareHeadForUserInput(
      this.deps.headId,
      this.deps.getSnapshot(),
    );
    if (autoBranch) {
      this.deps.setHead(autoBranch.head);
      this.deps.setRef(autoBranch.ref);
      await this.deps.conversationProjector.appendUiOnlyMessage({
        id: createId("ui"),
        role: "info",
        content: autoBranch.message,
        createdAt: new Date().toISOString(),
      });
    }

    this.deps.setApprovalHandlingMode(task.approvalMode ?? "interactive");
    await this.enrichUserInputBeforeRunLoop({
      modelMessageId,
      rawInput: task.input,
      createdAt: now,
      buildModelInputAppendix: task.buildModelInputAppendix,
    });
    await this.runLoop();
  }

  public async commitAssistantTurn(input: {
    content: string;
    toolCalls: ToolCall[];
  }): Promise<{
    assistantMessageId?: string;
  }> {
    if (!input.content && input.toolCalls.length === 0) {
      return {};
    }

    const now = new Date().toISOString();
    const assistantMessageId = createId("llm");
    await this.deps.conversationProjector.appendConversationEntry(
      createConversationEntry({
        kind: "assistant-turn",
        createdAt: now,
        ui: input.content.trim()
          ? {
              id: createId("ui"),
              role: "assistant",
              content: input.content,
              createdAt: now,
            }
          : undefined,
        model: {
          id: assistantMessageId,
          role: "assistant",
          content: input.content,
          toolCalls: input.toolCalls.length > 0 ? input.toolCalls : undefined,
          createdAt: now,
        },
      }),
    );
    this.deps.emitRuntimeEvent("assistant.completed", {
      assistantMessageId,
      content: input.content,
      toolCalls: input.toolCalls,
    });
    return {
      assistantMessageId,
    };
  }

  public async commitToolResult(result: {
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
    this.deps.setSnapshot({
      ...this.deps.getSnapshot(),
      shellCwd: result.cwd,
    });
    const now = new Date().toISOString();
    await this.deps.conversationProjector.appendConversationEntry(
      createConversationEntry({
        kind: "tool-result",
        createdAt: now,
        ui: buildToolUiMessage(result),
        model: {
          id: createId("llm"),
          role: "tool",
          name: "shell",
          toolCallId: result.callId,
          content: formatToolResultForModel(result),
          createdAt: now,
        },
      }),
    );
    this.deps.emitRuntimeEvent("tool.finished", {
      result,
    });
  }

  public async setStatus(
    status: AgentLifecycleStatus,
    detail: string,
  ): Promise<void> {
    this.status = status;
    this.statusDetail = detail;
    this.deps.clearPendingApprovalIfNeeded(status);
    await this.deps.conversationProjector.persistEvent(
      createAgentStatusSetEvent({
        workingHeadId: this.deps.headId,
        sessionId: this.deps.sessionId,
        mode: status,
        detail,
      }),
    );
    await this.deps.conversationProjector.persistSnapshot();
    this.deps.emitRuntimeEvent("status.changed", {
      status,
      detail,
    });
    this.deps.onStateChanged();
  }

  public async executeToolCall(
    toolCall: ToolCall,
  ): Promise<{
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
  }> {
    this.deps.emitRuntimeEvent("tool.started", {
      toolCall,
    });
    return this.deps.toolRegistry.execute(toolCall, {
      timeoutMs: this.buildRuntimeConfig().runtime.shellCommandTimeoutMs,
      onStdoutChunk: (chunk) => {
        this.deps.emitRuntimeEvent("tool.output.delta", {
          callId: toolCall.id,
          command: toolCall.input.command,
          stream: "stdout",
          chunk,
          cwd: this.deps.getShellCwd(),
          startedAt: toolCall.createdAt,
        });
      },
      onStderrChunk: (chunk) => {
        this.deps.emitRuntimeEvent("tool.output.delta", {
          callId: toolCall.id,
          command: toolCall.input.command,
          stream: "stderr",
          chunk,
          cwd: this.deps.getShellCwd(),
          startedAt: toolCall.createdAt,
        });
      },
    });
  }

  private createRunner(): AgentRunner {
    return new AgentRunner({
      config: this.buildRuntimeConfig(),
      promptAssembler: this.deps.promptAssembler,
      promptProfile: this.deps.policy.promptProfile ?? "default",
      toolMode: this.deps.policy.toolMode ?? "shell",
      modelClient: this.modelClient,
      toolRegistry: this.deps.toolRegistry,
      approvalPolicy: this.deps.runtimeApprovalPolicy,
      getModelMessages: () => this.deps.getSnapshot().modelMessages,
      getAvailableSkills: () => this.deps.getAvailableSkills(),
      getShellCwd: () => this.deps.getShellCwd(),
      getLastUserPrompt: () => this.deps.getSnapshot().lastUserPrompt,
      beforeModelTurn: async () => {
        await this.deps.onBeforeModelTurn?.();
      },
      searchRelevantMemory: async (query) =>
        (await this.getMemoryService()).search(query, 5),
      commitAssistantTurn: async ({ content, toolCalls }) =>
        this.commitAssistantTurn({ content, toolCalls }),
      commitToolResult: async (result) => this.commitToolResult(result),
      onToolStart: async (toolCall) => {
        this.deps.emitRuntimeEvent("tool.started", {
          toolCall,
        });
      },
      onToolOutput: ({ toolCall, stream, chunk }) => {
        this.deps.emitRuntimeEvent("tool.output.delta", {
          callId: toolCall.id,
          command: toolCall.input.command,
          stream,
          chunk,
          cwd: this.deps.getShellCwd(),
          startedAt: toolCall.createdAt,
        });
      },
      emitInfo: async (message) => {
        await this.deps.conversationProjector.appendUiOnlyMessage({
          id: createId("ui"),
          role: "info",
          content: message,
          createdAt: new Date().toISOString(),
        });
      },
      emitError: async (message) => {
        await this.deps.conversationProjector.appendUiOnlyMessage({
          id: createId("ui"),
          role: "error",
          content: message,
          createdAt: new Date().toISOString(),
        });
        this.deps.emitRuntimeEvent("runtime.error", {
          message,
        });
      },
      setStatus: async (mode, detail) => {
        if (mode === "idle") {
          const nextStatus = this.deps.kind === "task" ? "completed" : "idle";
          const nextDetail = this.deps.kind === "task" ? "任务已完成" : detail;
          await this.setStatus(nextStatus, nextDetail);
          await this.deps.refreshSessionState();
          if (this.deps.onRunLoopCompleted) {
            await this.deps.onRunLoopCompleted();
            await this.deps.refreshSessionState();
          }
          return;
        }
        await this.setStatus(mode, detail);
      },
      startAssistantDraft: async () => {
        this.draftAssistantText = "";
        this.deps.onStateChanged();
      },
      pushAssistantDraft: async (delta) => {
        this.draftAssistantText = `${this.draftAssistantText}${delta}`;
        this.deps.emitRuntimeEvent("assistant.delta", {
          delta,
          text: this.draftAssistantText,
        });
        this.deps.onStateChanged();
      },
      finishAssistantDraft: async () => {
        this.draftAssistantText = "";
        this.deps.onStateChanged();
      },
      requestApproval: async (request, context) => this.deps.requestApproval(request, context),
    });
  }

  private buildRuntimeConfig(): RuntimeConfig {
    return {
      ...this.config,
      model: {
        ...this.config.model,
        systemPrompt: this.deps.policy.systemPrompt ?? this.config.model.systemPrompt,
      },
      runtime: {
        ...this.config.runtime,
        maxAgentSteps:
          this.deps.policy.maxAgentSteps ?? this.config.runtime.maxAgentSteps,
      },
    };
  }

  private buildModelUserInput(
    input: string,
    now: string,
    appendix?: string,
  ): string {
    const normalizedAppendix = appendix?.trim();
    if (this.deps.promptProfile !== "default") {
      return normalizedAppendix ? `${input}\n\n${normalizedAppendix}` : input;
    }

    const sections = [
      `当前时间：${now}`,
      `当前 shell 工作目录：${this.deps.getShellCwd()}`,
      `当前工具审批模式：${this.deps.runtimeApprovalPolicy.getMode()}`,
      `当前最大自治步数：${this.buildRuntimeConfig().runtime.maxAgentSteps}`,
      "",
      input,
    ];
    if (normalizedAppendix) {
      sections.push("", normalizedAppendix);
    }
    return sections.join("\n");
  }

  private async enrichUserInputBeforeRunLoop(input: {
    modelMessageId: string;
    rawInput: string;
    createdAt: string;
    buildModelInputAppendix?: () => Promise<string | undefined>;
  }): Promise<void> {
    if (!input.buildModelInputAppendix) {
      return;
    }

    let appendix: string | undefined;
    try {
      appendix = await input.buildModelInputAppendix();
    } catch (error) {
      await this.deps.conversationProjector.appendUiOnlyMessage({
        id: createId("ui"),
        role: "error",
        content: `fetch-memory 失败，已跳过：${(error as Error).message}`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const normalizedAppendix = appendix?.trim();
    if (!normalizedAppendix) {
      return;
    }

    const nextContent = this.buildModelUserInput(
      input.rawInput,
      input.createdAt,
      normalizedAppendix,
    );
    let updated = false;
    this.deps.setSnapshot(projectSnapshotConversationEntries(
      {
        ...this.deps.getSnapshot(),
        conversationEntries: this.deps.getSnapshot().conversationEntries.map((entry) => {
          if (entry.model?.id !== input.modelMessageId) {
            return entry;
          }
          updated = true;
          return {
            ...entry,
            model: {
              ...entry.model,
              content: nextContent,
            },
          };
        }),
      },
      this.deps.isUiContextEnabled(),
    ));
    if (!updated) {
      return;
    }
    await this.deps.conversationProjector.persistSnapshot();
    this.deps.onStateChanged();
  }

  private async getMemoryService(): Promise<MemoryService> {
    const state = this.deps.getHead().assetState.memory as
      | {
          projectMemoryDir?: string;
          globalMemoryDir?: string;
        }
      | undefined;
    if (!state?.projectMemoryDir || !state?.globalMemoryDir) {
      throw new Error(`agent ${this.deps.getHead().name} 缺少 memory asset state。`);
    }
    return new MemoryService({
      projectMemoryDir: state.projectMemoryDir,
      globalMemoryDir: state.globalMemoryDir,
    });
  }
}
