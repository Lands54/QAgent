import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/context/index.js";
import {
  createMemorySessionAssetProvider,
  MemoryService,
} from "../../src/memory/index.js";
import {
  AgentManager,
  AutoMemoryForkService,
} from "../../src/runtime/index.js";
import { SessionService } from "../../src/session/index.js";
import { ApprovalPolicy } from "../../src/tool/index.js";
import type {
  LlmMessage,
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
  ResolvedPaths,
  RuntimeConfig,
} from "../../src/types.js";
import {
  buildProjectMemoryWriteCommand,
  getNativeHostShellFixture,
} from "../helpers/hostShellFixture.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function buildResolvedPaths(homeDir: string, projectDir: string): ResolvedPaths {
  return {
    cwd: projectDir,
    homeDir,
    globalAgentDir: path.join(homeDir, ".agent"),
    projectRoot: projectDir,
    projectAgentDir: path.join(projectDir, ".agent"),
    globalConfigPath: path.join(homeDir, ".agent", "config.json"),
    projectConfigPath: path.join(projectDir, ".agent", "config.json"),
    globalMemoryDir: path.join(homeDir, ".agent", "memory"),
    projectMemoryDir: path.join(projectDir, ".agent", "memory"),
    globalSkillsDir: path.join(homeDir, ".agent", "skills"),
    projectSkillsDir: path.join(projectDir, ".agent", "skills"),
    sessionRoot: path.join(projectDir, ".agent", "sessions"),
  };
}

class MemoryForkModelClient implements ModelClient {
  private turn = 0;
  public readonly requests: ModelTurnRequest[] = [];

  public constructor(private readonly shell = getNativeHostShellFixture()) {}

  public async runTurn(
    request: ModelTurnRequest,
  ): Promise<ModelTurnResult> {
    this.turn += 1;
    this.requests.push(request);

    if (this.turn === 1) {
      return {
        assistantText: "",
        toolCalls: [
          {
            id: "tool-1",
            name: "shell",
            createdAt: new Date().toISOString(),
            input: {
              command: buildProjectMemoryWriteCommand(this.shell, [
                "---",
                "name: auto-summary",
                "description: 自动总结最近一次 runLoop 的经验",
                "---",
                "",
                "沉淀最近一次 runLoop 中值得长期保留的指导。",
              ].join("\n")),
            },
          },
        ],
        finishReason: "tool_calls",
      };
    }

    return {
      assistantText: "已更新 project memory，写入最近一次 runLoop 的长期指导。",
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

describe("AutoMemoryForkService", () => {
  it("能在后台 fork 中写入 memory，并 merge 回正式目录", async () => {
    const homeDir = await makeTempDir("qagent-home-");
    const projectDir = await makeTempDir("qagent-project-");
    const resolvedPaths = buildResolvedPaths(homeDir, projectDir);
    const config: RuntimeConfig = {
      cwd: projectDir,
      resolvedPaths,
      model: {
        provider: "openai",
        baseUrl: "https://example.invalid/v1",
        model: "test-model",
        temperature: 0,
        systemPrompt: "你是一个运行时测试代理。",
      },
      runtime: {
        maxAgentSteps: 6,
        fetchMemoryMaxAgentSteps: 3,
        autoMemoryForkMaxAgentSteps: 4,
        shellCommandTimeoutMs: 15_000,
        maxToolOutputChars: 12_000,
        maxConversationSummaryMessages: 10,
        autoCompactThresholdTokens: 120_000,
        compactRecentKeepGroups: 8,
      },
      tool: {
        approvalMode: "always",
        shellExecutable: getNativeHostShellFixture().executable,
      },
      cli: {},
    };

    const sessionService = new SessionService(resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: resolvedPaths.projectMemoryDir,
        globalMemoryDir: resolvedPaths.globalMemoryDir,
      }),
    ]);
    const modelClient = new MemoryForkModelClient();
    const agentManager = new AgentManager(
      config,
      modelClient,
      new PromptAssembler(),
      sessionService,
      new ApprovalPolicy("always"),
      () => [],
    );
    const initialized = await agentManager.initialize({
      cwd: projectDir,
      shellCwd: projectDir,
      approvalMode: "always",
    });
    const service = new AutoMemoryForkService(agentManager);
    const modelMessages: LlmMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "请记住最近一次 runLoop 中值得长期保留的指导。",
        createdAt: new Date().toISOString(),
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "我会把这些 runLoop 指导整理进记忆。",
        createdAt: new Date().toISOString(),
      },
    ];

    const result = await service.run({
      sourceAgentId: initialized.head.id,
      targetAgentId: initialized.head.id,
      targetSnapshot: initialized.snapshot,
      availableSkills: [],
      lastUserPrompt: "请记住最近一次 runLoop 中值得长期保留的指导。",
      modelMessages,
    });
    const targetHead = await sessionService.getHead(initialized.head.id);
    const memoryState = targetHead.assetState.memory as {
      projectMemoryDir: string;
      globalMemoryDir: string;
    };
    const merged = await new MemoryService(memoryState).show("auto-summary");
    const request = modelClient.requests[0];
    const lastMessage = request?.messages.at(-1);

    expect(result.report).toContain("已更新 project memory");
    expect(request?.systemPrompt).toContain("MEMORY.md");
    expect(request?.systemPrompt).toContain("kebab-case");
    expect(request?.systemPrompt).toContain(
      "优先把新信息整合进最匹配的现有 memory",
    );
    expect(request?.systemPrompt).toContain(
      "只有在确实找不到合适的现有 memory",
    );
    expect(request?.systemPrompt).toContain(
      "禁止创建旧格式 `*.json` memory 文件",
    );
    expect(request?.systemPrompt).toContain("name: reply-language");
    expect(request?.systemPrompt).not.toContain("可用 Skill 元数据");
    expect(request?.systemPrompt).not.toContain("最近会话摘要");
    expect(request?.systemPrompt).not.toContain("## Memory:");
    expect(request?.systemPrompt).not.toContain(memoryState.projectMemoryDir);
    expect(lastMessage?.role).toBe("user");
    expect(lastMessage?.content).toContain("当前时间：");
    expect(lastMessage?.content).toContain("project memory");
    expect(lastMessage?.content).toContain("global memory");
    expect(lastMessage?.content).toContain("runLoop");
    expect(lastMessage?.content).toContain("MEMORY.md");
    expect(lastMessage?.content).toContain("上一轮用户任务：请记住最近一次 runLoop 中值得长期保留的指导。");
    expect(lastMessage?.content).toContain("第一步先查看已有 memory 目录与 `MEMORY.md`");
    expect(lastMessage?.content).toContain("优先修改最匹配的现有 memory");
    expect(lastMessage?.content).toContain("$QAGENT_PROJECT_MEMORY_DIR");
    expect(lastMessage?.content).toContain("$QAGENT_GLOBAL_MEMORY_DIR");
    expect(merged?.scope).toBe("project");
    expect(merged?.path).toBe(
      path.join(memoryState.projectMemoryDir, "auto-summary", "MEMORY.md"),
    );
    expect(merged?.description).toBe("自动总结最近一次 runLoop 的经验");
    expect(merged?.content).toContain(
      "沉淀最近一次 runLoop 中值得长期保留的指导。",
    );
  });
});
