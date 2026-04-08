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
import { getNativeHostShellFixture } from "../helpers/hostShellFixture.js";

const hostShell = getNativeHostShellFixture();

function getApprovalCommand(): string {
  return hostShell.family === "powershell"
    ? "Write-Output checkpoint-approved"
    : "printf checkpoint-approved";
}

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
      shellExecutable: hostShell.executable,
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
            command: getApprovalCommand(),
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
      expect(result.checkpoint?.toolCall.input.command).toBe(getApprovalCommand());
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
});
