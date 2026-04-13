import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/context/promptAssembler.js";
import { createMemorySessionAssetProvider } from "../../src/memory/index.js";
import { AgentRunner } from "../../src/runtime/agentRunner.js";
import { AgentManager } from "../../src/runtime/index.js";
import { SessionService } from "../../src/session/index.js";
import { SkillRegistry } from "../../src/skills/skillRegistry.js";
import { ApprovalPolicy } from "../../src/tool/approvalPolicy.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  LlmMessage,
  MemoryRecord,
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
  RuntimeConfig,
  RuntimeEvent,
  SessionAssetProvider,
  SkillManifest,
  ToolCall,
  ToolResult,
} from "../../src/types.js";
import {
  VALID_MOCK_SKILL_NAMES,
  buildMockSkillResolvedPaths,
  buildMockSkillRuntimeConfig,
} from "../helpers/mockSkillFixture.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (check()) {
      return;
    }
    await sleep(10);
  }
  throw new Error("等待条件超时。");
}

function buildTempRuntimeConfig(projectDir: string): RuntimeConfig {
  return {
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
      fetchMemoryMaxAgentSteps: 3,
      autoMemoryForkMaxAgentSteps: 4,
      shellCommandTimeoutMs: 10_000,
      maxToolOutputChars: 2_000,
      maxConversationSummaryMessages: 10,
      autoCompactThresholdTokens: 120_000,
      compactRecentKeepGroups: 8,
    },
    tool: {
      approvalMode: "always",
      shellExecutable: "/bin/zsh",
    },
    cli: {},
  };
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
    const config = buildTempRuntimeConfig(projectDir);

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

  it("dispose 会中断正在等待模型响应的 runLoop", async () => {
    const projectDir = await makeTempDir("qagent-dispose-running-");
    const config = buildTempRuntimeConfig(projectDir);

    class HangingModelClient implements ModelClient {
      public signal?: AbortSignal;
      private resolveStarted?: () => void;
      public readonly started = new Promise<void>((resolve) => {
        this.resolveStarted = resolve;
      });

      public async runTurn(
        _request: ModelTurnRequest,
        _hooks?: unknown,
        signal?: AbortSignal,
      ): Promise<ModelTurnResult> {
        this.signal = signal;
        this.resolveStarted?.();
        return new Promise<ModelTurnResult>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }

    const modelClient = new HangingModelClient();
    const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ]);
    const agentManager = new AgentManager(
      config,
      modelClient,
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    agentManager.setFetchMemoryHookEnabled(false);

    const running = agentManager.submitInputToActiveAgent("保持等待");
    await modelClient.started;

    await expect(agentManager.dispose()).resolves.toBeUndefined();
    await expect(running).resolves.toBeUndefined();
    expect(modelClient.signal?.aborted).toBe(true);
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

  it("default agent 会把动态运行时信息放到 user message 前缀，而不是 system prompt", async () => {
    const projectDir = await makeTempDir("qagent-default-prompt-");
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
        systemPrompt: "你是一个终端 Agent。",
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
    const capturedRequests: ModelTurnRequest[] = [];

    class InspectingModelClient implements ModelClient {
      public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
        capturedRequests.push(request);
        return {
          assistantText: "已处理",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    }

    const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ]);
    const agentManager = new AgentManager(
      config,
      new InspectingModelClient(),
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    const taskAgent = await agentManager.spawnTaskAgent({
      name: "prompt-checker",
      autoMemoryFork: false,
      retainOnCompletion: true,
      promptProfile: "default",
    });

    await agentManager.submitInputToAgent(taskAgent.id, "请看看当前目录");

    const request = capturedRequests[0];
    const lastMessage = request?.messages.at(-1);

    expect(request?.systemPrompt).toContain("你是一个终端 Agent。");
    expect(request?.systemPrompt).not.toContain("当前时间：");
    expect(request?.systemPrompt).not.toContain(projectDir);
    expect(request?.systemPrompt).not.toContain("Recent Session Digest");
    expect(request?.systemPrompt).not.toContain("## Memory:");
    expect(lastMessage?.role).toBe("user");
    expect(lastMessage?.content).toContain("当前时间：");
    expect(lastMessage?.content).toContain(`当前 shell 工作目录：${projectDir}`);
    expect(lastMessage?.content).toContain("当前工具审批模式：always");
    expect(lastMessage?.content).toContain("当前最大自治步数：4");
    expect(lastMessage?.content).toContain("请看看当前目录");
  });

  it("会在进入 runLoop 前通过 fetch-memory 子 agent 追加未出现在历史中的 Memory.md", async () => {
    const projectDir = await makeTempDir("qagent-fetch-memory-");
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
        systemPrompt: "你是一个终端 Agent。",
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
    const mainRequests: ModelTurnRequest[] = [];
    const fetchRequests: ModelTurnRequest[] = [];

    class FetchAwareModelClient implements ModelClient {
      public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
        if (request.systemPrompt.includes("fetch-memory 子任务")) {
          fetchRequests.push(request);
          return {
            assistantText: JSON.stringify({
              selectedMemoryNames: ["reply-language"],
            }),
            toolCalls: [],
            finishReason: "stop",
          };
        }

        mainRequests.push(request);
        return {
          assistantText: "已处理",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    }

    const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ]);
    const agentManager = new AgentManager(
      config,
      new FetchAwareModelClient(),
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    await agentManager.saveMemory({
      name: "reply-language",
      description: "回复语言偏好",
      content: "请默认使用中文回复。",
    });
    const taskAgent = await agentManager.spawnTaskAgent({
      name: "main-task",
      autoMemoryFork: false,
      retainOnCompletion: true,
      promptProfile: "default",
    });

    await agentManager.submitInputToAgent(taskAgent.id, "帮我写一个答复");

    const fetchRequest = fetchRequests[0];
    const mainRequest = mainRequests[0];
    const mainLastMessage = mainRequest?.messages.at(-1);

    expect(fetchRequest?.systemPrompt).toContain("fetch-memory 子任务");
    expect(fetchRequest?.messages.at(-1)?.content).toContain("当前用户请求：");
    expect(fetchRequest?.messages.at(-1)?.content).toContain("reply-language");
    expect(mainLastMessage?.role).toBe("user");
    expect(mainLastMessage?.content).toContain("帮我写一个答复");
    expect(mainLastMessage?.content).toContain(
      "以下是系统自动补充的 Memory.md 参考",
    );
    expect(mainLastMessage?.content).toContain("### MEMORY.md: reply-language");
    expect(mainLastMessage?.content).toContain("description: 回复语言偏好");
    expect(mainLastMessage?.content).toContain("请默认使用中文回复。");
    expect(
      agentManager.listAgents().some((agent) => agent.name.startsWith("fetch-memory-")),
    ).toBe(false);
  });

  it("关闭 fetch-memory hook 后，不会再创建 fetch-memory 子 agent", async () => {
    const projectDir = await makeTempDir("qagent-fetch-memory-off-");
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
        systemPrompt: "你是一个终端 Agent。",
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
    const capturedRequests: ModelTurnRequest[] = [];

    class InspectingModelClient implements ModelClient {
      public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
        capturedRequests.push(request);
        return {
          assistantText: "已处理",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    }

    const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ]);
    const agentManager = new AgentManager(
      config,
      new InspectingModelClient(),
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    agentManager.setFetchMemoryHookEnabled(false);
    await agentManager.saveMemory({
      name: "reply-language",
      description: "回复语言偏好",
      content: "请默认使用中文回复。",
    });
    const taskAgent = await agentManager.spawnTaskAgent({
      name: "main-task-off",
      autoMemoryFork: false,
      retainOnCompletion: true,
      promptProfile: "default",
    });

    await agentManager.submitInputToAgent(taskAgent.id, "帮我写一个答复");

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.systemPrompt).not.toContain("fetch-memory 子任务");
    expect(capturedRequests[0]?.messages.at(-1)?.content).not.toContain(
      "以下是系统自动补充的 Memory.md 参考",
    );
    expect(agentManager.listAgents().some((agent) => agent.name.startsWith("fetch-memory-"))).toBe(false);
  });

  it("关闭 save-memory hook 后，interactive agent 完成时不会触发 auto memory fork", async () => {
    const projectDir = await makeTempDir("qagent-save-memory-off-");
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
        systemPrompt: "你是一个终端 Agent。",
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
    const capturedRequests: ModelTurnRequest[] = [];

    class InspectingModelClient implements ModelClient {
      public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
        capturedRequests.push(request);
        return {
          assistantText: "已完成主任务",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    }

    const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ]);
    const agentManager = new AgentManager(
      config,
      new InspectingModelClient(),
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    agentManager.setFetchMemoryHookEnabled(false);
    agentManager.setSaveMemoryHookEnabled(false);

    await agentManager.submitInputToActiveAgent("帮我完成这个任务");

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.systemPrompt).not.toContain("自动 memory fork 子任务");
    expect(agentManager.listAgents().some((agent) => agent.name.startsWith("auto-memory-"))).toBe(false);
  });

  it("主 agent 完成后会自动清理 auto-memory 子 agent", async () => {
    const projectDir = await makeTempDir("qagent-auto-memory-visible-");
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
        systemPrompt: "你是一个终端 Agent。",
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
    const capturedRequests: ModelTurnRequest[] = [];

    class InspectingModelClient implements ModelClient {
      public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
        capturedRequests.push(request);
        if (request.systemPrompt.includes("自动 memory fork 子任务")) {
          return {
            assistantText: "没有新增记忆，本轮只做了检查。",
            toolCalls: [],
            finishReason: "stop",
          };
        }
        return {
          assistantText: "主任务已完成",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    }

    const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ]);
    const agentManager = new AgentManager(
      config,
      new InspectingModelClient(),
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    agentManager.setFetchMemoryHookEnabled(false);

    await agentManager.submitInputToActiveAgent("帮我完成这个任务");

    await waitForCondition(() => {
      return capturedRequests.some((request) => {
        return request.systemPrompt.includes("自动 memory fork 子任务");
      });
    });
    await waitForCondition(() => {
      return !agentManager.listAgents().some((agent) => agent.name.startsWith("auto-memory-"));
    });

    expect(capturedRequests.some((request) => request.systemPrompt.includes("自动 memory fork 子任务"))).toBe(true);
    expect(
      agentManager.listAgents().some((agent) => agent.name.startsWith("auto-memory-")),
    ).toBe(false);
  });

  it("auto memory fork 会异步执行，不阻塞主任务完成", async () => {
    const projectDir = await makeTempDir("qagent-auto-memory-async-");
    const config = buildTempRuntimeConfig(projectDir);
    let releaseAutoMemory!: () => void;
    const autoMemoryBlocked = new Promise<void>((resolve) => {
      releaseAutoMemory = resolve;
    });
    const capturedRequests: ModelTurnRequest[] = [];

    class AsyncAutoMemoryModelClient implements ModelClient {
      public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
        capturedRequests.push(request);
        if (request.systemPrompt.includes("自动 memory fork 子任务")) {
          await autoMemoryBlocked;
          return {
            assistantText: "没有新增记忆，本轮只做了检查。",
            toolCalls: [],
            finishReason: "stop",
          };
        }
        return {
          assistantText: "主任务已完成",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    }

    const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ]);
    const agentManager = new AgentManager(
      config,
      new AsyncAutoMemoryModelClient(),
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    agentManager.setFetchMemoryHookEnabled(false);

    try {
      const settled = await Promise.race([
        agentManager.submitInputToActiveAgent("帮我完成这个任务").then(() => "completed"),
        sleep(100).then(() => "timeout"),
      ]);

      expect(settled).toBe("completed");
      await waitForCondition(() => {
        return capturedRequests.some((request) => {
          return request.systemPrompt.includes("自动 memory fork 子任务");
        });
      });
    } finally {
      releaseAutoMemory();
      await waitForCondition(() => {
        return !agentManager.listAgents().some((agent) => agent.name.startsWith("auto-memory-"));
      });
      await agentManager.dispose();
    }
  });

  it("auto memory fork 失败时会发出 runtime.warning，且不影响主任务完成", async () => {
    const projectDir = await makeTempDir("qagent-auto-memory-warning-");
    const config = buildTempRuntimeConfig(projectDir);
    const events: RuntimeEvent[] = [];

    class FailingAutoMemoryModelClient implements ModelClient {
      public async runTurn(_request: ModelTurnRequest): Promise<ModelTurnResult> {
        return {
          assistantText: "主任务已完成",
          toolCalls: [],
          finishReason: "stop",
        };
      }
    }

    const failingProvider: SessionAssetProvider = {
      kind: "auto-memory-failing-provider",
      async fork(input) {
        if (input.head.name.startsWith("auto-memory-")) {
          throw new Error("memory helper boom");
        }
        return {};
      },
      async checkpoint(input) {
        return input.state;
      },
      async merge(input) {
        return {
          targetState: input.targetState,
        };
      },
    };

    const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
      failingProvider,
    ]);
    const agentManager = new AgentManager(
      config,
      new FailingAutoMemoryModelClient(),
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    agentManager.subscribeRuntimeEvents((event) => {
      events.push(event);
    });
    await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    agentManager.setFetchMemoryHookEnabled(false);

    try {
      await expect(
        agentManager.submitInputToActiveAgent("帮我完成这个任务"),
      ).resolves.toBeUndefined();

      await waitForCondition(() => {
        return events.some((event) => {
          return (
            event.type === "runtime.warning"
            && event.payload.source === "post-run.auto-memory-fork"
          );
        });
      });

      expect(events.some((event) => {
        return (
          event.type === "runtime.warning"
          && event.payload.source === "post-run.auto-memory-fork"
          && event.payload.message.includes("memory helper boom")
        );
      })).toBe(true);
      expect(
        agentManager.getActiveRuntime().getSnapshot().uiMessages.some((message) => {
          return message.role === "error" && message.content.includes("自动 memory fork 失败");
        }),
      ).toBe(true);
    } finally {
      await agentManager.dispose();
    }
  });
});
