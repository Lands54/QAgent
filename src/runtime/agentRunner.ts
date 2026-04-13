import {
  loadAgentInstructionLayers,
  type PromptAssembler,
} from "../context/index.js";
import type { ApprovalPolicy, ToolRegistry } from "../tool/index.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  LlmMessage,
  MemoryRecord,
  ModelClient,
  PromptProfile,
  RuntimeConfig,
  SkillManifest,
  ToolCall,
  ToolMode,
  ToolResult,
} from "../types.js";
import { ApprovalRequiredInterruptError } from "./runtimeErrors.js";

interface ApprovalRequestContext {
  step: number;
  assistantMessageId: string;
  toolCalls: ReadonlyArray<ToolCall>;
  nextToolCallIndex: number;
}

interface AgentRunnerDependencies {
  config: RuntimeConfig;
  promptAssembler: PromptAssembler;
  promptProfile?: PromptProfile;
  toolMode?: ToolMode;
  modelClient: ModelClient;
  toolRegistry: ToolRegistry;
  approvalPolicy: ApprovalPolicy;
  getModelMessages: () => ReadonlyArray<LlmMessage>;
  getAvailableSkills: () => SkillManifest[];
  getShellCwd: () => string;
  getLastUserPrompt: () => string | undefined;
  beforeModelTurn?: () => Promise<void>;
  searchRelevantMemory: (query: string) => Promise<MemoryRecord[]>;
  commitAssistantTurn: (input: {
    content: string;
    toolCalls: ToolCall[];
  }) => Promise<{
    assistantMessageId?: string;
  }>;
  commitToolResult: (result: ToolResult) => Promise<void>;
  onToolStart?: (toolCall: ToolCall) => Promise<void>;
  onToolOutput?: (input: {
    toolCall: ToolCall;
    stream: "stdout" | "stderr";
    chunk: string;
  }) => void;
  emitInfo: (message: string) => Promise<void>;
  emitError: (message: string) => Promise<void>;
  setStatus: (
    mode: "idle" | "running" | "awaiting-approval" | "interrupted" | "error",
    detail: string,
  ) => Promise<void>;
  startAssistantDraft: () => Promise<void>;
  pushAssistantDraft: (delta: string) => Promise<void>;
  finishAssistantDraft: () => Promise<void>;
  requestApproval: (
    request: ApprovalRequest,
    context: ApprovalRequestContext,
  ) => Promise<ApprovalDecision>;
}

export class AgentRunner {
  private abortController?: AbortController;
  private idlePromise?: Promise<void>;
  private resolveIdle?: () => void;
  private running = false;

  public constructor(private readonly deps: AgentRunnerDependencies) {}

  public isRunning(): boolean {
    return this.running;
  }

  public async runLoop(input?: {
    startStep?: number;
    toolCalls?: ReadonlyArray<ToolCall>;
    nextToolCallIndex?: number;
    assistantMessageId?: string;
  }): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.idlePromise = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
    this.abortController = new AbortController();

    try {
      let pendingToolCalls = input?.toolCalls;
      let pendingToolCallIndex = input?.nextToolCallIndex ?? 0;
      let pendingAssistantMessageId = input?.assistantMessageId ?? "";
      for (
        let step = input?.startStep ?? 1;
        step <= this.deps.config.runtime.maxAgentSteps;
        step += 1
      ) {
        this.ensureNotAborted();

        if (pendingToolCalls && pendingToolCalls.length > 0) {
          await this.deps.setStatus(
            "running",
            `Agent 正在继续执行，第 ${step}/${this.deps.config.runtime.maxAgentSteps} 步`,
          );
          await this.executeToolCalls({
            step,
            assistantMessageId: pendingAssistantMessageId,
            toolCalls: pendingToolCalls,
            nextToolCallIndex: pendingToolCallIndex,
          });
          pendingToolCalls = undefined;
          pendingToolCallIndex = 0;
          pendingAssistantMessageId = "";
          continue;
        }

        await this.deps.beforeModelTurn?.();
        await this.deps.setStatus(
          "running",
          `Agent 正在执行，第 ${step}/${this.deps.config.runtime.maxAgentSteps} 步`,
        );

        const prompt = this.deps.promptAssembler.assemble({
          config: this.deps.config,
          profile: this.deps.promptProfile ?? "default",
          agentLayers: await loadAgentInstructionLayers(
            this.deps.config.resolvedPaths,
          ),
          availableSkills: this.deps.getAvailableSkills(),
          relevantMemories: [],
          modelMessages: this.deps.getModelMessages(),
          shellCwd: this.deps.getShellCwd(),
          toolMode: this.deps.toolMode,
        });

        const result = await this.deps.modelClient.runTurn(
          {
            systemPrompt: prompt.systemPrompt,
            messages: this.deps.getModelMessages(),
            tools: this.deps.toolRegistry.getDefinitions(),
          },
          {
            onTextStart: async () => {
              await this.deps.startAssistantDraft();
            },
            onTextDelta: async (delta) => {
              await this.deps.pushAssistantDraft(delta);
            },
            onTextComplete: async () => {
              await this.deps.finishAssistantDraft();
            },
          },
          this.abortController.signal,
        );

        await this.deps.finishAssistantDraft();
        const committedAssistantTurn = await this.deps.commitAssistantTurn({
          content: result.assistantText,
          toolCalls: result.toolCalls,
        }) ?? {};

        if (result.toolCalls.length === 0) {
          await this.deps.setStatus("idle", "等待输入");
          return;
        }

        await this.executeToolCalls({
          step,
          assistantMessageId: committedAssistantTurn.assistantMessageId ?? "",
          toolCalls: result.toolCalls,
          nextToolCallIndex: 0,
        });
      }

      await this.deps.emitInfo("达到最大自治步数，已停止当前任务。");
      await this.deps.setStatus("idle", "等待输入");
    } catch (error) {
      if (error instanceof ApprovalRequiredInterruptError) {
        return;
      }
      if ((error as Error).name === "AbortError") {
        await this.deps.emitInfo("Agent 已被中断。");
        await this.deps.setStatus("interrupted", "已中断");
      } else {
        await this.deps.emitError((error as Error).message);
        await this.deps.setStatus("error", "运行失败");
      }
    } finally {
      this.running = false;
      this.abortController = undefined;
      this.resolveIdle?.();
      this.resolveIdle = undefined;
      this.idlePromise = undefined;
    }
  }

  public interrupt(): void {
    this.abortController?.abort();
  }

  public async waitForIdle(): Promise<void> {
    await this.idlePromise;
  }

  private ensureNotAborted(): void {
    this.abortController?.signal.throwIfAborted();
  }

  private async executeToolCalls(
    context: ApprovalRequestContext,
  ): Promise<void> {
    for (
      let index = context.nextToolCallIndex;
      index < context.toolCalls.length;
      index += 1
    ) {
      this.ensureNotAborted();

      const toolCall = context.toolCalls[index];
      if (!toolCall) {
        continue;
      }
      const assessment = this.deps.approvalPolicy.evaluate(toolCall);
      let approved = true;
      if (assessment.requiresApproval && assessment.request) {
        const decision = await this.deps.requestApproval(assessment.request, {
          ...context,
          nextToolCallIndex: index,
        });
        approved = decision.approved;
      }

      const toolResult = approved
        ? await this.executeApprovedTool(toolCall)
        : {
            callId: toolCall.id,
            name: "shell" as const,
            command: toolCall.input.command,
            status: "rejected" as const,
            exitCode: null,
            stdout: "",
            stderr: "命令执行被用户拒绝。",
            cwd: this.deps.getShellCwd(),
            durationMs: 0,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };

      await this.deps.commitToolResult(toolResult);
    }
  }

  private async executeApprovedTool(toolCall: ToolCall): Promise<ToolResult> {
    await this.deps.onToolStart?.(toolCall);
    return this.deps.toolRegistry.execute(toolCall, {
      timeoutMs: this.deps.config.runtime.shellCommandTimeoutMs,
      signal: this.abortController?.signal,
      onStdoutChunk: (chunk) => {
        this.deps.onToolOutput?.({
          toolCall,
          stream: "stdout",
          chunk,
        });
      },
      onStderrChunk: (chunk) => {
        this.deps.onToolOutput?.({
          toolCall,
          stream: "stderr",
          chunk,
        });
      },
    });
  }
}
