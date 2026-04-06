import type {
  ApprovalDecision,
  ApprovalRequest,
  LlmMessage,
  MemoryRecord,
  ModelClient,
  RuntimeConfig,
  SkillManifest,
  ToolCall,
  ToolResult,
} from "../types.js";
import { loadAgentInstructionLayers, PromptAssembler } from "../context/index.js";
import type { ApprovalPolicy, ToolRegistry } from "../tool/index.js";

interface AgentRunnerDependencies {
  config: RuntimeConfig;
  promptAssembler: PromptAssembler;
  modelClient: ModelClient;
  toolRegistry: ToolRegistry;
  approvalPolicy: ApprovalPolicy;
  getModelMessages: () => LlmMessage[];
  getAvailableSkills: () => SkillManifest[];
  getShellCwd: () => string;
  getLastUserPrompt: () => string | undefined;
  searchRelevantMemory: (query: string) => Promise<MemoryRecord[]>;
  commitAssistantTurn: (input: {
    content: string;
    toolCalls: ToolCall[];
  }) => Promise<void>;
  commitToolResult: (result: ToolResult) => Promise<void>;
  emitInfo: (message: string) => Promise<void>;
  emitError: (message: string) => Promise<void>;
  setStatus: (
    mode: "idle" | "running" | "awaiting-approval" | "interrupted" | "error",
    detail: string,
  ) => Promise<void>;
  startAssistantDraft: () => Promise<void>;
  pushAssistantDraft: (delta: string) => Promise<void>;
  finishAssistantDraft: () => Promise<void>;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

export class AgentRunner {
  private abortController?: AbortController;
  private running = false;

  public constructor(private readonly deps: AgentRunnerDependencies) {}

  public isRunning(): boolean {
    return this.running;
  }

  public async runLoop(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.abortController = new AbortController();

    try {
      for (
        let step = 1;
        step <= this.deps.config.runtime.maxAgentSteps;
        step += 1
      ) {
        this.ensureNotAborted();
        await this.deps.setStatus(
          "running",
          `Agent 正在执行，第 ${step}/${this.deps.config.runtime.maxAgentSteps} 步`,
        );

        const query = this.deps.getLastUserPrompt() ?? "";
        const relevantMemory = query
          ? await this.deps.searchRelevantMemory(query)
          : [];
        const prompt = this.deps.promptAssembler.assemble({
          config: this.deps.config,
          agentLayers: await loadAgentInstructionLayers(
            this.deps.config.resolvedPaths,
          ),
          availableSkills: this.deps.getAvailableSkills(),
          relevantMemories: relevantMemory,
          modelMessages: this.deps.getModelMessages(),
          shellCwd: this.deps.getShellCwd(),
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
        await this.deps.commitAssistantTurn({
          content: result.assistantText,
          toolCalls: result.toolCalls,
        });

        if (result.toolCalls.length === 0) {
          await this.deps.setStatus("idle", "等待输入");
          return;
        }

        for (const toolCall of result.toolCalls) {
          this.ensureNotAborted();

          const assessment = this.deps.approvalPolicy.evaluate(toolCall);
          let approved = true;
          if (assessment.requiresApproval && assessment.request) {
            const decision = await this.deps.requestApproval(assessment.request);
            approved = decision.approved;
          }

          const toolResult = approved
            ? await this.deps.toolRegistry.execute(toolCall, {
                timeoutMs: this.deps.config.runtime.shellCommandTimeoutMs,
                signal: this.abortController.signal,
              })
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

      await this.deps.emitInfo("达到最大自治步数，已停止当前任务。");
      await this.deps.setStatus("idle", "等待输入");
    } catch (error) {
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
    }
  }

  public interrupt(): void {
    this.abortController?.abort();
  }

  private ensureNotAborted(): void {
    this.abortController?.signal.throwIfAborted();
  }
}
