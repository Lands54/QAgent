import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/context/promptAssembler.js";
import { createMemorySessionAssetProvider } from "../../src/memory/index.js";
import { AgentManager } from "../../src/runtime/agentManager.js";
import { COMPACT_SUMMARY_PREFIX } from "../../src/runtime/compactSessionService.js";
import { SessionService } from "../../src/session/index.js";
import { ApprovalPolicy } from "../../src/tool/approvalPolicy.js";
import type {
  LlmMessage,
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
  RuntimeConfig,
  UIMessage,
} from "../../src/types.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function buildConfig(
  projectDir: string,
  overrides?: {
    runtime?: Partial<RuntimeConfig["runtime"]>;
  },
): RuntimeConfig {
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
      systemPrompt: "你是一个终端 Agent。",
    },
    runtime: {
      maxAgentSteps: 4,
      fetchMemoryMaxAgentSteps: 3,
      autoMemoryForkMaxAgentSteps: 4,
      shellCommandTimeoutMs: 10_000,
      maxToolOutputChars: 2_000,
      maxConversationSummaryMessages: 10,
      autoCompactThresholdTokens: 120_000,
      compactRecentKeepGroups: 1,
      ...overrides?.runtime,
    },
    tool: {
      approvalMode: "always",
      shellExecutable: "/bin/zsh",
    },
    cli: {},
  };
}

function buildHistory(prefix = "历史"): LlmMessage[] {
  const createdAt = "2026-01-01T00:00:00.000Z";
  return [
    {
      id: "user-1",
      role: "user",
      content: `${prefix}需求一：请分析当前实现并记录关键决策。${"A".repeat(160)}`,
      createdAt,
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: `${prefix}答复一：已经分析代码与约束。${"B".repeat(160)}`,
      createdAt,
    },
    {
      id: "user-2",
      role: "user",
      content: `${prefix}需求二：继续整理风险与后续工作。${"C".repeat(160)}`,
      createdAt,
    },
    {
      id: "assistant-2",
      role: "assistant",
      content: `${prefix}答复二：已经列出风险和下一步。${"D".repeat(160)}`,
      createdAt,
    },
  ];
}

class CompactAwareModelClient implements ModelClient {
  public readonly mainRequests: ModelTurnRequest[] = [];
  public readonly compactRequests: ModelTurnRequest[] = [];

  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    if (request.systemPrompt.includes("compact-session 子任务")) {
      this.compactRequests.push(request);
      return {
        assistantText: [
          "1. 用户目标与约束",
          "保留之前的任务目标、限制条件以及当前需要继续的工作。",
          "",
          "2. 关键决策与当前实现状态",
          "已经完成 compact v1 的主体实现，需要保留最近原始上下文。",
          "",
          "3. 重要文件、命令与错误",
          "涉及 src/runtime/compactSessionService.ts 与 session graph 持久化。",
          "",
          "4. 待办与下一步",
          "继续基于摘要后的上下文完成当前用户请求。",
        ].join("\n"),
        toolCalls: [],
        finishReason: "stop",
      };
    }

    this.mainRequests.push(request);
    return {
      assistantText: "已处理当前请求",
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

async function createAgentManager(
  config: RuntimeConfig,
  modelClient: ModelClient,
): Promise<AgentManager> {
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
    cwd: config.cwd,
    shellCwd: config.cwd,
    approvalMode: "always",
  });
  return agentManager;
}

describe("compact session integration", () => {
  it("手动 compact 会替换 modelMessages、保留 uiMessages，并写入 compact node", async () => {
    const projectDir = await makeTempDir("qagent-compact-manual-");
    const config = buildConfig(projectDir);
    const modelClient = new CompactAwareModelClient();
    const agentManager = await createAgentManager(config, modelClient);
    const runtime = agentManager.getActiveRuntime();
    const originalUiMessages: UIMessage[] = [
      {
        id: "ui-1",
        role: "user",
        content: "界面里原本可见的历史消息",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    await runtime.seedConversation({
      modelMessages: buildHistory(),
      uiMessages: originalUiMessages,
      lastUserPrompt: "继续整理 compact 方案",
    });

    const result = await agentManager.compactSession();
    const snapshot = agentManager.getActiveRuntime().getSnapshot();
    const log = await agentManager.listSessionLog();
    expect(result.compacted).toBe(true);
    expect(modelClient.compactRequests).toHaveLength(1);
    expect(modelClient.compactRequests[0]?.tools).toEqual([]);
    expect(snapshot.modelMessages[0]?.role).toBe("user");
    expect(snapshot.modelMessages[0]?.content).toContain(COMPACT_SUMMARY_PREFIX);
    expect(snapshot.modelMessages).toHaveLength(3);
    expect(snapshot.uiMessages).toEqual(originalUiMessages);
    expect(log.some((entry) => entry.kind === "compact")).toBe(true);
    expect(
      agentManager.listAgents().some((agent) => agent.helperType === "compact-session"),
    ).toBe(false);
  });

  it("超过阈值时会在主请求前自动 compact，并把摘要留在 modelMessages 中", async () => {
    const projectDir = await makeTempDir("qagent-compact-auto-");
    const config = buildConfig(projectDir, {
      runtime: {
        autoCompactThresholdTokens: 80,
        compactRecentKeepGroups: 1,
      },
    });
    const modelClient = new CompactAwareModelClient();
    const agentManager = await createAgentManager(config, modelClient);
    const runtime = agentManager.getActiveRuntime();

    await runtime.seedConversation({
      modelMessages: buildHistory("自动压缩历史"),
      uiMessages: [],
      lastUserPrompt: "上一轮任务",
    });

    await agentManager.submitInputToActiveAgent("请继续完成当前工作");

    const snapshot = agentManager.getActiveRuntime().getSnapshot();
    const mainRequest = modelClient.mainRequests[0];
    expect(modelClient.compactRequests).toHaveLength(1);
    expect(mainRequest).toBeTruthy();
    expect(mainRequest?.messages.some((message) => {
      return message.role === "user" && message.content.includes(COMPACT_SUMMARY_PREFIX);
    })).toBe(true);
    expect(snapshot.modelMessages[0]?.content).toContain(COMPACT_SUMMARY_PREFIX);
    expect(snapshot.modelMessages.at(-1)?.role).toBe("assistant");
    expect(snapshot.uiMessages.some((message) => {
      return message.role === "user" && message.content === "请继续完成当前工作";
    })).toBe(true);
    expect(
      agentManager.listAgents().some((agent) => agent.helperType === "compact-session"),
    ).toBe(false);
  });
});
