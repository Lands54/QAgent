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
  RuntimeEvent,
} from "../../src/types.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
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
      approvalMode: "never",
      shellExecutable: "/bin/zsh",
    },
    cli: {},
  };
}

class ToolStreamingModelClient implements ModelClient {
  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const executed = request.messages.some((message) => {
      return (
        message.role === "tool"
        && message.toolCallId === "tool-stream-1"
        && message.content.includes("hello world")
        && message.content.includes("err-line")
      );
    });

    if (executed) {
      return {
        assistantText: "命令执行完成",
        toolCalls: [],
        finishReason: "stop",
      };
    }

    return {
      assistantText: "",
      toolCalls: [
        {
          id: "tool-stream-1",
          name: "shell",
          createdAt: new Date().toISOString(),
          input: {
            command: "printf 'hello'; sleep 0.05; printf ' err-line' >&2; sleep 0.05; printf ' world'",
          },
        },
      ],
      finishReason: "tool_calls",
    };
  }
}

async function createAgentManager(
  config: RuntimeConfig,
  modelClient: ModelClient,
  events: RuntimeEvent[],
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
    new ApprovalPolicy(config.tool.approvalMode),
    () => [],
  );

  agentManager.subscribeRuntimeEvents((event) => {
    events.push(event);
  });

  await agentManager.initialize({
    cwd: config.cwd,
    shellCwd: config.cwd,
    approvalMode: config.tool.approvalMode,
  });
  return agentManager;
}

describe("tool streaming integration", () => {
  it("shell 命令会发出实时输出事件并保留最终结果", async () => {
    const projectDir = await makeTempDir("qagent-tool-stream-");
    const config = buildConfig(projectDir);
    const events: RuntimeEvent[] = [];
    const agentManager = await createAgentManager(
      config,
      new ToolStreamingModelClient(),
      events,
    );

    try {
      agentManager.setFetchMemoryHookEnabled(false);
      agentManager.setSaveMemoryHookEnabled(false);

      await agentManager.submitInputToActiveAgent("请执行一个带输出的命令");

      const eventTypes = events.map((event) => event.type);
      const toolStartedIndex = eventTypes.indexOf("tool.started");
      const toolOutputIndex = eventTypes.indexOf("tool.output.delta");
      const toolFinishedIndex = eventTypes.indexOf("tool.finished");
      const assistantCompletedIndex = eventTypes.lastIndexOf("assistant.completed");

      expect(toolStartedIndex).toBeGreaterThanOrEqual(0);
      expect(toolOutputIndex).toBeGreaterThan(toolStartedIndex);
      expect(toolFinishedIndex).toBeGreaterThan(toolOutputIndex);
      expect(assistantCompletedIndex).toBeGreaterThan(toolFinishedIndex);

      const outputEvents = events.filter((event) => event.type === "tool.output.delta");
      const stdout = outputEvents
        .filter((event) => event.payload.stream === "stdout")
        .map((event) => event.payload.chunk)
        .join("");
      const stderr = outputEvents
        .filter((event) => event.payload.stream === "stderr")
        .map((event) => event.payload.chunk)
        .join("");

      expect(stdout).toContain("hello world");
      expect(stdout).not.toContain("__QAGENT_EXIT__");
      expect(stderr).toContain("err-line");

      const toolFinishedEvent = events.find((event) => event.type === "tool.finished");
      expect(toolFinishedEvent?.payload.result.stdout).toContain("hello world");
      expect(toolFinishedEvent?.payload.result.stderr).toContain("err-line");
    } finally {
      await agentManager.dispose();
    }
  });
});
