import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/context/promptAssembler.js";
import { createMemorySessionAssetProvider } from "../../src/memory/index.js";
import { AgentManager } from "../../src/runtime/agentManager.js";
import { SessionService } from "../../src/session/index.js";
import { ApprovalPolicy } from "../../src/tool/approvalPolicy.js";
import type {
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
  RuntimeConfig,
} from "../../src/types.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildConfig(projectDir: string): RuntimeConfig {
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
      compactRecentKeepGroups: 8,
    },
    tool: {
      approvalMode: "always",
      shellExecutable: "/bin/zsh",
    },
    cli: {},
  };
}

class SlowFetchMemoryModelClient implements ModelClient {
  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    if (request.systemPrompt.includes("fetch-memory 子任务")) {
      await sleep(300);
      return {
        assistantText: JSON.stringify({
          selectedMemoryNames: ["reply-language"],
        }),
        toolCalls: [],
        finishReason: "stop",
      };
    }

    return {
      assistantText: "已处理",
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

describe("input echo integration", () => {
  it("慢速 fetch-memory 不应阻塞用户消息回显", async () => {
    const projectDir = await makeTempDir("qagent-input-echo-");
    const config = buildConfig(projectDir);
    const agentManager = await createAgentManager(
      config,
      new SlowFetchMemoryModelClient(),
    );

    try {
      await agentManager.saveMemory({
        name: "reply-language",
        description: "回复语言偏好",
        content: "请默认使用中文回复。",
      });

      const submission = agentManager.submitInputToActiveAgent("帮我写一个答复");
      await sleep(60);

      const snapshotWhileFetching = agentManager.getActiveRuntime().getSnapshot();
      const userModelMessageWhileFetching = snapshotWhileFetching.modelMessages
        .filter((message) => message.role === "user")
        .at(-1);
      expect(snapshotWhileFetching.lastUserPrompt).toBe("帮我写一个答复");
      expect(snapshotWhileFetching.uiMessages.some((message) => {
        return message.role === "user" && message.content === "帮我写一个答复";
      })).toBe(true);
      expect(userModelMessageWhileFetching?.content).not.toContain(
        "以下是系统自动补充的 Memory.md 参考",
      );

      await submission;

      const finalSnapshot = agentManager.getActiveRuntime().getSnapshot();
      const finalUserModelMessage = finalSnapshot.modelMessages
        .filter((message) => message.role === "user")
        .at(-1);
      expect(finalUserModelMessage?.content).toContain(
        "以下是系统自动补充的 Memory.md 参考",
      );
    } finally {
      await agentManager.dispose();
    }
  });
});
