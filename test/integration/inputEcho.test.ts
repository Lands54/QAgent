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

class ControlledFetchMemoryModelClient implements ModelClient {
  public readonly fetchMemoryStarted: Promise<void>;
  private readonly fetchMemoryReleased: Promise<void>;
  private resolveFetchMemoryStarted?: () => void;
  private resolveFetchMemory?: () => void;

  public constructor() {
    this.fetchMemoryStarted = new Promise<void>((resolve) => {
      this.resolveFetchMemoryStarted = resolve;
    });
    this.fetchMemoryReleased = new Promise<void>((resolve) => {
      this.resolveFetchMemory = resolve;
    });
  }

  public releaseFetchMemory(): void {
    this.resolveFetchMemory?.();
  }

  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    if (request.systemPrompt.includes("fetch-memory 子任务")) {
      this.resolveFetchMemoryStarted?.();
      await this.fetchMemoryReleased;
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

class QueuedInputModelClient implements ModelClient {
  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const latestUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    const latestContent = latestUserMessage?.content ?? "";

    if (latestContent.includes("first")) {
      await sleep(150);
      return {
        assistantText: "done:first",
        toolCalls: [],
        finishReason: "stop",
      };
    }

    if (latestContent.includes("second")) {
      return {
        assistantText: "done:second",
        toolCalls: [],
        finishReason: "stop",
      };
    }

    return {
      assistantText: "done:unknown",
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
    const modelClient = new ControlledFetchMemoryModelClient();
    const agentManager = await createAgentManager(
      config,
      modelClient,
    );

    try {
      await agentManager.saveMemory({
        name: "reply-language",
        description: "回复语言偏好",
        content: "请默认使用中文回复。",
      });

      const submission = agentManager.submitInputToActiveAgent("帮我写一个答复");
      await modelClient.fetchMemoryStarted;

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

      modelClient.releaseFetchMemory();
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

  it("运行中连续输入会进入 FIFO 队列并顺序执行", async () => {
    const projectDir = await makeTempDir("qagent-input-queue-");
    const config = buildConfig(projectDir);
    const agentManager = await createAgentManager(
      config,
      new QueuedInputModelClient(),
    );

    try {
      agentManager.setFetchMemoryHookEnabled(false);
      agentManager.setSaveMemoryHookEnabled(false);

      const first = agentManager.submitInputToActiveAgent("first");
      await sleep(30);
      const second = agentManager.submitInputToActiveAgent("second");
      await sleep(30);

      expect(agentManager.getActiveRuntime().getViewState().queuedInputCount).toBe(1);
      expect(agentManager.getExecutorStatus().queuedInputCount).toBe(1);
      expect(agentManager.getWorklineStatus().queuedInputCount).toBe(1);

      await Promise.all([first, second]);

      const snapshot = agentManager.getActiveRuntime().getSnapshot();
      const userMessages = snapshot.uiMessages
        .filter((message) => message.role === "user")
        .map((message) => message.content);
      const assistantMessages = snapshot.uiMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content);

      expect(userMessages.slice(-2)).toEqual(["first", "second"]);
      expect(assistantMessages.slice(-2)).toEqual(["done:first", "done:second"]);
      expect(agentManager.getExecutorStatus().queuedInputCount).toBe(0);
      expect(agentManager.getWorklineStatus().queuedInputCount).toBe(0);
    } finally {
      await agentManager.dispose();
    }
  });
});
