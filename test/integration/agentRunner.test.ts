import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type {
  ApprovalDecision,
  ApprovalRequest,
  LlmMessage,
  MemoryRecord,
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
  RuntimeConfig,
  SkillManifest,
  ToolCall,
  ToolResult,
} from "../../src/types.js";
import { PromptAssembler } from "../../src/context/promptAssembler.js";
import { AgentRunner } from "../../src/runtime/agentRunner.js";
import { SkillRegistry } from "../../src/skills/skillRegistry.js";
import { ApprovalPolicy } from "../../src/tool/approvalPolicy.js";
import {
  VALID_MOCK_SKILL_NAMES,
  buildMockSkillResolvedPaths,
  buildMockSkillRuntimeConfig,
} from "../helpers/mockSkillFixture.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

class FakeModelClient implements ModelClient {
  private turn = 0;

  public async runTurn(
    _request: ModelTurnRequest,
    hooks?: { onTextStart?: () => void; onTextDelta?: (delta: string) => void; onTextComplete?: (text: string) => void },
  ): Promise<ModelTurnResult> {
    this.turn += 1;

    if (this.turn === 1) {
      return {
        assistantText: "",
        toolCalls: [
          {
            id: "tool-1",
            name: "shell",
            createdAt: new Date().toISOString(),
            input: {
              command: "pwd",
            },
          },
        ],
        finishReason: "tool_calls",
      };
    }

    hooks?.onTextStart?.();
    hooks?.onTextDelta?.("完成");
    hooks?.onTextComplete?.("完成");
    return {
      assistantText: "完成",
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

describe("AgentRunner", () => {
  it("能在工具调用后继续下一轮并产出最终回答", async () => {
    const projectDir = await makeTempDir("qagent-runner-");
    const config: RuntimeConfig = {
      cwd: projectDir,
      resolvedPaths: {
        cwd: projectDir,
        homeDir: projectDir,
        globalAgentDir: path.join(projectDir, ".global"),
        projectRoot: projectDir,
        projectAgentDir: path.join(projectDir, ".agent"),
        globalConfigPath: path.join(projectDir, ".global", "config.json"),
        projectConfigPath: path.join(projectDir, ".agent", "config.json"),
        globalMemoryDir: path.join(projectDir, ".global", "memory"),
        projectMemoryDir: path.join(projectDir, ".agent", "memory"),
        globalSkillsDir: path.join(projectDir, ".global", "skills"),
        projectSkillsDir: path.join(projectDir, ".agent", "skills"),
        sessionRoot: path.join(projectDir, ".agent", "sessions"),
      },
      model: {
        provider: "openai",
        baseUrl: "https://example.invalid/v1",
        model: "test-model",
        temperature: 0,
      },
      runtime: {
        maxAgentSteps: 4,
        shellCommandTimeoutMs: 10_000,
        maxToolOutputChars: 2_000,
        maxConversationSummaryMessages: 10,
      },
      tool: {
        approvalMode: "always",
        shellExecutable: "/bin/zsh",
      },
      cli: {},
    };

    const modelMessages: LlmMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "请看看当前目录",
        createdAt: new Date().toISOString(),
      },
    ];
    const assistantTurns: Array<{ content: string; toolCalls: ToolCall[] }> = [];
    const toolResults: ToolResult[] = [];
    const approvals: ApprovalRequest[] = [];
    const statusLines: string[] = [];

    const runner = new AgentRunner({
      config,
      promptAssembler: new PromptAssembler(),
      modelClient: new FakeModelClient(),
      toolRegistry: {
        getDefinitions: () => [],
        execute: async () => {
          const result: ToolResult = {
            callId: "tool-1",
            name: "shell",
            command: "pwd",
            status: "success",
            exitCode: 0,
            stdout: projectDir,
            stderr: "",
            cwd: projectDir,
            durationMs: 10,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
          toolResults.push(result);
          modelMessages.push({
            id: "tool-message",
            role: "tool",
            name: "shell",
            toolCallId: "tool-1",
            content: projectDir,
            createdAt: new Date().toISOString(),
          });
          return result;
        },
      } as never,
      approvalPolicy: new ApprovalPolicy("always"),
      getModelMessages: () => modelMessages,
      getAvailableSkills: () => [] as SkillManifest[],
      getShellCwd: () => projectDir,
      getLastUserPrompt: () => "请看看当前目录",
      searchRelevantMemory: async () => [] as MemoryRecord[],
      commitAssistantTurn: async (turn) => {
        assistantTurns.push(turn);
        if (turn.content || turn.toolCalls.length > 0) {
          modelMessages.push({
            id: `assistant-${assistantTurns.length}`,
            role: "assistant",
            content: turn.content,
            toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
            createdAt: new Date().toISOString(),
          });
        }
      },
      commitToolResult: async (result) => {
        toolResults.push(result);
      },
      emitInfo: async () => {},
      emitError: async (message) => {
        throw new Error(message);
      },
      setStatus: async (_mode, detail) => {
        statusLines.push(detail);
      },
      startAssistantDraft: async () => {},
      pushAssistantDraft: async () => {},
      finishAssistantDraft: async () => {},
      requestApproval: async (request): Promise<ApprovalDecision> => {
        approvals.push(request);
        return {
          requestId: request.id,
          approved: true,
          decidedAt: new Date().toISOString(),
        };
      },
    });

    await runner.runLoop();

    expect(approvals).toHaveLength(1);
    expect(toolResults[0]?.command).toBe("pwd");
    expect(assistantTurns.at(-1)?.content).toBe("完成");
    expect(statusLines.at(-1)).toBe("等待输入");
  });

  it("会在运行时把全部 mock skill 的 YAML 元信息注入 system prompt，并且只暴露一个 shell tool", async () => {
    const config = buildMockSkillRuntimeConfig({
      runtime: {
        maxAgentSteps: 2,
        shellCommandTimeoutMs: 15_000,
        maxToolOutputChars: 12_000,
        maxConversationSummaryMessages: 10,
      },
    });
    const registry = new SkillRegistry(buildMockSkillResolvedPaths());
    const skills = await registry.refresh();
    const capturedRequests: ModelTurnRequest[] = [];

    class InspectingModelClient implements ModelClient {
      public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
        capturedRequests.push(request);
        return {
          assistantText: "已检查 skill catalog",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    }

    const runner = new AgentRunner({
      config,
      promptAssembler: new PromptAssembler(),
      modelClient: new InspectingModelClient(),
      toolRegistry: {
        getDefinitions: () => [
          {
            name: "shell",
            description: "Execute a non-interactive shell command.",
            inputSchema: {
              type: "object",
            },
          },
        ],
        execute: async () => {
          throw new Error("not used");
        },
      } as never,
      approvalPolicy: new ApprovalPolicy("always"),
      getModelMessages: () => [
        {
          id: "user-1",
          role: "user",
          content: "帮我找合适的 skill",
          createdAt: new Date().toISOString(),
        },
      ],
      getAvailableSkills: () => skills,
      getShellCwd: () => config.cwd,
      getLastUserPrompt: () => "帮我找合适的 skill",
      searchRelevantMemory: async () => [],
      commitAssistantTurn: async () => {},
      commitToolResult: async () => {},
      emitInfo: async () => {},
      emitError: async (message) => {
        throw new Error(message);
      },
      setStatus: async () => {},
      startAssistantDraft: async () => {},
      pushAssistantDraft: async () => {},
      finishAssistantDraft: async () => {},
      requestApproval: async (request): Promise<ApprovalDecision> => ({
        requestId: request.id,
        approved: true,
        decidedAt: new Date().toISOString(),
      }),
    });

    await runner.runLoop();

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.tools).toHaveLength(1);
    expect(capturedRequests[0]?.tools[0]?.name).toBe("shell");

    const systemPrompt = capturedRequests[0]?.systemPrompt ?? "";
    for (const skillName of VALID_MOCK_SKILL_NAMES) {
      expect(systemPrompt).toContain(`name: "${skillName}"`);
    }
    expect(systemPrompt).not.toContain("PROJECT BODY MARKER: pdf-processing");
    expect(systemPrompt).not.toContain("GLOBAL BODY MARKER: api-testing");
  });
});
