import { describe, expect, it, vi } from "vitest";

import { ApprovalRequiredInterruptError } from "../../src/runtime/runtimeErrors.js";
import { RuntimeApprovalCoordinator } from "../../src/runtime/application/runtimeApprovalCoordinator.js";
import type {
  ApprovalRequest,
  PendingApprovalCheckpoint,
  ToolCall,
} from "../../src/types.js";

function buildToolCall(): ToolCall {
  return {
    id: "tool_1",
    name: "shell",
    createdAt: new Date().toISOString(),
    input: {
      command: "pwd",
    },
  };
}

function buildRequest(toolCall: ToolCall): ApprovalRequest {
  return {
    id: "approval_request_1",
    toolCall,
    summary: "执行 shell 命令：pwd",
    riskLevel: "medium",
    createdAt: new Date().toISOString(),
  };
}

describe("RuntimeApprovalCoordinator", () => {
  it("checkpoint 模式下会持久化 checkpoint 并抛出中断错误", async () => {
    const saved: PendingApprovalCheckpoint[] = [];
    const setStatus = vi.fn(async () => {});
    const emitRuntimeEvent = vi.fn();
    const coordinator = new RuntimeApprovalCoordinator({
      agentId: "executor_1",
      headId: "head_main",
      sessionId: "session_main",
      getShellCwd: () => "/tmp/project",
      getApprovalHandlingMode: () => "checkpoint",
      setApprovalHandlingMode: vi.fn(),
      sessionService: {
        getHead: vi.fn(),
        getHeadStatus: vi.fn(),
        getPendingApprovalCheckpoint: vi.fn(async () => undefined),
        savePendingApprovalCheckpoint: vi.fn(async (checkpoint) => {
          saved.push(checkpoint);
        }),
        clearPendingApprovalCheckpoint: vi.fn(async () => {}),
        updateHeadRuntimeState: vi.fn(),
        prepareHeadForUserInput: vi.fn(),
        flushCompactSnapshot: vi.fn(),
        persistWorkingEvent: vi.fn(),
        persistWorkingSnapshot: vi.fn(),
      },
      setStatus,
      runLoop: vi.fn(),
      executeToolCall: vi.fn(),
      commitToolResult: vi.fn(),
      onStateChanged: vi.fn(),
      emitRuntimeEvent,
    });

    await expect(coordinator.requestApproval(buildRequest(buildToolCall()), {
      step: 1,
      assistantMessageId: "assistant_1",
      toolCalls: [buildToolCall()],
      nextToolCallIndex: 0,
    })).rejects.toBeInstanceOf(ApprovalRequiredInterruptError);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.approvalRequest.id).toBe("approval_request_1");
    expect(setStatus).toHaveBeenCalledWith("awaiting-approval", "执行 shell 命令：pwd");
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      "approval.required",
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          headId: "head_main",
          assistantMessageId: "assistant_1",
        }),
      }),
    );
  });
});
