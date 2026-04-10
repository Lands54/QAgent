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
        assistantText: "已根据审批结果继续完成",
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
            command: "printf checkpoint-approved",
          },
        },
      ],
      finishReason: "tool_calls",
    };
  }
}

class ApprovalQueueModelClient implements ModelClient {
  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const latestUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    const latestContent = latestUserMessage?.content ?? "";

    if (latestContent.includes("second")) {
      return {
        assistantText: "已处理 second",
        toolCalls: [],
        finishReason: "stop",
      };
    }

    const alreadyExecuted = request.messages.some((message) => {
      return (
        message.role === "tool"
        && message.toolCallId === "tool-approval-queue"
        && message.content.includes("queue-approved")
      );
    });

    if (alreadyExecuted) {
      return {
        assistantText: "已处理 first",
        toolCalls: [],
        finishReason: "stop",
      };
    }

    return {
      assistantText: "",
      toolCalls: [
        {
          id: "tool-approval-queue",
          name: "shell",
          createdAt: new Date().toISOString(),
          input: {
            command: "printf queue-approved",
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
      expect(result.checkpoint?.toolCall.input.command).toBe("printf checkpoint-approved");
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
          && message.content.includes("已根据审批结果继续完成")
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

  it("待审批期间后续输入会排队，审批完成后继续消费", async () => {
    const projectDir = await makeTempDir("qagent-pending-approval-queue-");
    const config = buildConfig(projectDir);
    const manager = await createAgentManager(
      config,
      new ApprovalQueueModelClient(),
    );
    let second: Promise<void> | undefined;

    try {
      manager.setFetchMemoryHookEnabled(false);
      manager.setSaveMemoryHookEnabled(false);

      const first = await manager.runAgentPrompt("first", {
        approvalMode: "checkpoint",
      });
      expect(first.settled).toBe("approval_required");
      expect(first.checkpoint?.toolCall.input.command).toBe("printf queue-approved");

      second = manager.submitInputToActiveAgent("second");
      void second.catch(() => {});
      await waitForCondition(() => manager.getExecutorStatus().queuedInputCount === 1);

      expect(manager.getPendingApprovalCheckpoint()).toBeDefined();
      expect(manager.getActiveRuntime().getViewState().queuedInputCount).toBe(1);
      expect(manager.getExecutorStatus().queuedInputCount).toBe(1);
      expect(manager.getWorklineStatus().queuedInputCount).toBe(1);

      const snapshotWhilePending = manager.getActiveRuntime().getSnapshot();
      const userMessagesWhilePending = snapshotWhilePending.uiMessages
        .filter((message) => message.role === "user")
        .map((message) => message.content);
      expect(userMessagesWhilePending.at(-1)).toBe("first");

      await manager.resolvePendingApprovalCheckpoint(true, {
        checkpointId: first.checkpoint?.checkpointId,
      });
      await waitForCondition(() => manager.getExecutorStatus().queuedInputCount === 0, 10_000);
      await second;

      const finalSnapshot = manager.getActiveRuntime().getSnapshot();
      const finalUserMessages = finalSnapshot.uiMessages
        .filter((message) => message.role === "user")
        .map((message) => message.content);
      const finalAssistantMessages = finalSnapshot.uiMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content);

      expect(finalUserMessages.slice(-2)).toEqual(["first", "second"]);
      expect(finalAssistantMessages.slice(-2)).toEqual(["已处理 first", "已处理 second"]);
      expect(manager.getPendingApprovalCheckpoint()).toBeUndefined();
      expect(manager.getExecutorStatus().queuedInputCount).toBe(0);
      expect(manager.getWorklineStatus().queuedInputCount).toBe(0);
    } finally {
      await manager.dispose();
    }
  }, 15_000);
});
