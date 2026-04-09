import { access, mkdtemp } from "node:fs/promises";
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
import {
  getPrintTextCommand,
  getTestShellExecutable,
} from "../helpers/shellTestHarness.js";

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
      approvalMode: "always",
      shellExecutable: getTestShellExecutable(),
    },
    cli: {},
  };
}

const approvalCommand = getPrintTextCommand("checkpoint-approved");

class ApprovalCheckpointModelClient implements ModelClient {
  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const alreadyExecuted = request.messages.some((message) => {
      return (
        message.role === "tool"
        && message.toolCallId === "tool-approval-1"
        && message.content.includes("checkpoint-approved")
      );
    });

    if (alreadyExecuted) {
      return {
        assistantText: "已根据审批结果继续完成。",
        toolCalls: [],
        finishReason: "stop",
      };
    }

    return {
      assistantText: "",
      toolCalls: [
        {
          id: "tool-approval-1",
          name: "shell",
          createdAt: new Date().toISOString(),
          input: {
            command: approvalCommand,
          },
        },
      ],
      finishReason: "tool_calls",
    };
  }
}

class StrictApprovalSequenceModelClient implements ModelClient {
  public callCount = 0;

  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.callCount += 1;
    this.assertNoDanglingToolCalls(request.messages);
    return {
      assistantText: "",
      toolCalls: [
        {
          id: "tool-approval-strict-1",
          name: "shell",
          createdAt: new Date().toISOString(),
          input: {
            command: approvalCommand,
          },
        },
      ],
      finishReason: "tool_calls",
    };
  }

  private assertNoDanglingToolCalls(
    messages: ReadonlyArray<ModelTurnRequest["messages"][number]>,
  ): void {
    const pendingToolCallIds = new Set<string>();
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const toolCall of message.toolCalls ?? []) {
          pendingToolCallIds.add(toolCall.id);
        }
        continue;
      }
      if (message.role === "tool") {
        pendingToolCallIds.delete(message.toolCallId);
      }
    }
    if (pendingToolCallIds.size === 0) {
      return;
    }
    throw new Error(
      `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. Missing: ${[...pendingToolCallIds].join(", ")}`,
    );
  }
}

async function createAgentManager(
  config: RuntimeConfig,
  modelClient: ModelClient,
  input?: {
    resumeSessionId?: string;
    events?: RuntimeEvent[];
  },
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
  if (input?.events) {
    agentManager.subscribeRuntimeEvents((event) => {
      input.events?.push(event);
    });
  }
  await agentManager.initialize({
    cwd: config.cwd,
    shellCwd: config.cwd,
    approvalMode: "always",
    resumeSessionId: input?.resumeSessionId,
  });
  return agentManager;
}

describe("pending approval integration", () => {
  it("能在重建 runtime 后恢复待审批 checkpoint 并继续原 runLoop", async () => {
    const projectDir = await makeTempDir("qagent-pending-approval-");
    const config = buildConfig(projectDir);
    const phaseOneEvents: RuntimeEvent[] = [];
    const firstManager = await createAgentManager(
      config,
      new ApprovalCheckpointModelClient(),
      {
        events: phaseOneEvents,
      },
    );

    let checkpointId = "";
    let sessionId = "";
    let pendingApprovalPath = "";

    try {
      const result = await firstManager.runAgentPrompt("请执行一次需要审批的命令");
      expect(result.settled).toBe("approval_required");
      expect(result.checkpoint?.toolCall.input.command).toBe(approvalCommand);
      expect(
        phaseOneEvents.some((event) => event.type === "approval.required"),
      ).toBe(true);

      checkpointId = result.checkpoint?.checkpointId ?? "";
      sessionId = result.checkpoint?.sessionId ?? "";
      pendingApprovalPath = path.join(
        config.resolvedPaths.sessionRoot,
        "__heads",
        result.checkpoint?.headId ?? "",
        "pending-approval.json",
      );
      await expect(access(pendingApprovalPath)).resolves.toBeUndefined();
    } finally {
      await firstManager.dispose();
    }

    const phaseTwoEvents: RuntimeEvent[] = [];
    const secondManager = await createAgentManager(
      config,
      new ApprovalCheckpointModelClient(),
      {
        resumeSessionId: sessionId,
        events: phaseTwoEvents,
      },
    );

    try {
      const restored = secondManager.getPendingApprovalCheckpoint({
        checkpointId,
      });
      expect(restored?.checkpointId).toBe(checkpointId);
      expect(secondManager.getActiveRuntime().getViewState().status).toBe("awaiting-approval");

      const resumed = await secondManager.resolvePendingApprovalCheckpoint(true, {
        checkpointId,
      });
      expect(resumed.settled).toBe("completed");
      expect(secondManager.getPendingApprovalCheckpoint({ checkpointId })).toBeUndefined();
      await expect(access(pendingApprovalPath)).rejects.toThrow();

      const snapshot = secondManager.getActiveRuntime().getSnapshot();
      expect(snapshot.modelMessages.some((message) => {
        return (
          message.role === "tool"
          && message.toolCallId === "tool-approval-1"
          && message.content.includes("checkpoint-approved")
        );
      })).toBe(true);
      expect(snapshot.uiMessages.some((message) => {
        return (
          message.role === "assistant"
          && message.content.includes("已根据审批结果继续完成。")
        );
      })).toBe(true);

      const eventTypes = phaseTwoEvents.map((event) => event.type);
      const approvalResolvedIndex = eventTypes.indexOf("approval.resolved");
      const toolStartedIndex = eventTypes.indexOf("tool.started");
      const toolFinishedIndex = eventTypes.indexOf("tool.finished");
      const assistantCompletedIndex = eventTypes.indexOf("assistant.completed");
      expect(approvalResolvedIndex).toBeGreaterThanOrEqual(0);
      expect(toolStartedIndex).toBeGreaterThan(approvalResolvedIndex);
      expect(toolFinishedIndex).toBeGreaterThan(toolStartedIndex);
      expect(assistantCompletedIndex).toBeGreaterThan(toolFinishedIndex);
    } finally {
      await secondManager.dispose();
    }
  });

  it("待审批未处理时再次 run 会直接返回现有 checkpoint", async () => {
    const projectDir = await makeTempDir("qagent-pending-approval-repeat-");
    const config = buildConfig(projectDir);
    const modelClient = new StrictApprovalSequenceModelClient();
    const manager = await createAgentManager(config, modelClient);

    try {
      const first = await manager.runAgentPrompt("第一次触发审批");
      expect(first.settled).toBe("approval_required");
      expect(modelClient.callCount).toBe(1);

      const second = await manager.runAgentPrompt("第二次继续提问");
      expect(second.settled).toBe("approval_required");
      expect(second.checkpoint?.checkpointId).toBe(first.checkpoint?.checkpointId);
      expect(modelClient.callCount).toBe(1);
    } finally {
      await manager.dispose();
    }
  });
});
