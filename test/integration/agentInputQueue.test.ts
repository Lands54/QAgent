import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/context/index.js";
import { AgentManager } from "../../src/runtime/index.js";
import { SessionService } from "../../src/session/index.js";
import { ApprovalPolicy } from "../../src/tool/index.js";
import type {
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
  RuntimeConfig,
} from "../../src/types.js";
import { getDefaultTestShellExecutable } from "../helpers/hostShellFixture.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

class QueuedModelClient implements ModelClient {
  private turn = 0;
  private releaseFirstTurnResolver?: () => void;
  private readonly releaseFirstTurnPromise = new Promise<void>((resolve) => {
    this.releaseFirstTurnResolver = resolve;
  });
  private firstTurnStartedResolver?: () => void;
  public readonly firstTurnStarted = new Promise<void>((resolve) => {
    this.firstTurnStartedResolver = resolve;
  });

  public async runTurn(
    _request: ModelTurnRequest,
    hooks?: {
      onTextStart?: () => void;
      onTextDelta?: (delta: string) => void;
      onTextComplete?: (text: string) => void;
    },
  ): Promise<ModelTurnResult> {
    this.turn += 1;
    const currentTurn = this.turn;
    if (currentTurn === 1) {
      this.firstTurnStartedResolver?.();
      await this.releaseFirstTurnPromise;
    }

    const text = `回复 ${currentTurn}`;
    hooks?.onTextStart?.();
    hooks?.onTextDelta?.(text);
    hooks?.onTextComplete?.(text);
    return {
      assistantText: text,
      toolCalls: [],
      finishReason: "stop",
    };
  }

  public releaseFirstTurn(): void {
    this.releaseFirstTurnResolver?.();
  }
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
      shellExecutable: getDefaultTestShellExecutable(),
    },
    cli: {},
  };
}

describe("AgentManager 输入队列", () => {
  it("会把同一 agent 的连续输入串行排队执行", async () => {
    const projectDir = await makeTempDir("qagent-queue-");
    const config = buildConfig(projectDir);
    const sessionService = new SessionService(config.resolvedPaths.sessionRoot);
    const modelClient = new QueuedModelClient();
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
    agentManager.setFetchMemoryHookEnabled(false);
    agentManager.setSaveMemoryHookEnabled(false);
    agentManager.setAutoCompactHookEnabled(false);

    const first = agentManager.submitInputToActiveAgent("任务一");
    await modelClient.firstTurnStarted;
    const second = agentManager.submitInputToActiveAgent("任务二");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      (agentManager.getAgentStatus() as { queuedInputCount?: number }).queuedInputCount ?? 0,
    ).toBe(1);

    modelClient.releaseFirstTurn();
    await Promise.all([first, second]);

    const snapshot = await sessionService.getHeadSnapshot(initialized.head.id);
    const assistantMessages = snapshot.modelMessages.filter((message) => {
      return message.role === "assistant";
    });
    const userMessages = snapshot.modelMessages.filter((message) => {
      return message.role === "user";
    });

    expect(assistantMessages.map((message) => message.content)).toEqual(["回复 1", "回复 2"]);
    expect(userMessages.some((message) => message.content.includes("任务一"))).toBe(true);
    expect(userMessages.some((message) => message.content.includes("任务二"))).toBe(true);
    expect(
      (agentManager.getAgentStatus() as { queuedInputCount?: number }).queuedInputCount ?? 0,
    ).toBe(0);

    await agentManager.dispose();
  });
});
