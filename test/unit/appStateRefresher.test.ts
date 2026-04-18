import { describe, expect, it, vi } from "vitest";

import { createEmptyState } from "../../src/runtime/appState.js";
import { AppStateRefresher } from "../../src/runtime/index.js";

describe("AppStateRefresher", () => {
  it("buildState 会复用 previousState 的 supplemental 数据并收集待审批映射", () => {
    const refresher = new AppStateRefresher();
    const previousState = {
      ...createEmptyState("/tmp/project"),
      bookmarks: [
        {
          name: "main",
          kind: "branch" as const,
          targetNodeId: "node_main",
          current: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sessionGraphEntries: [
        {
          id: "node_main",
          kind: "root" as const,
          parentNodeIds: [],
          refs: ["branch:main"],
          summaryTitle: "初始化会话",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const runtime = {
      agentId: "executor_main",
      headId: "head_main",
      sessionId: "session_main",
      getViewState: () => ({
        id: "executor_main",
        headId: "head_main",
        sessionId: "session_main",
        name: "main",
        kind: "interactive" as const,
        status: "idle" as const,
        detail: "等待输入",
        shellCwd: "/tmp/project",
        dirty: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        autoMemoryFork: true,
        retainOnCompletion: true,
        queuedInputCount: 0,
      }),
      getSnapshot: () => ({
        workingHeadId: "head_main",
        sessionId: "session_main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/project",
        shellCwd: "/tmp/project",
        approvalMode: "never" as const,
        conversationEntries: [],
        uiMessages: [],
        modelMessages: [],
      }),
      getPendingApproval: () => undefined,
      getDraftAssistantText: () => "",
      getRef: () => undefined,
      getHead: () => undefined,
    };

    const state = refresher.buildState({
      cwd: "/tmp/project",
      previousState,
      stateSource: {
        getActiveRuntime: () => runtime as never,
        listAgents: () => [
          {
            id: "executor_main",
            headId: "head_main",
            sessionId: "session_main",
            name: "main",
            kind: "interactive",
            status: "idle",
            autoMemoryFork: true,
            retainOnCompletion: true,
            detail: "等待输入",
            shellCwd: "/tmp/project",
            dirty: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "executor_helper",
            headId: "head_helper",
            sessionId: "session_helper",
            name: "helper",
            kind: "task",
            status: "awaiting-approval",
            autoMemoryFork: false,
            retainOnCompletion: true,
            detail: "等待审批",
            shellCwd: "/tmp/project",
            dirty: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            pendingApproval: {
              id: "approval_1",
              summary: "执行 shell 命令",
              riskLevel: "medium",
              createdAt: "2026-01-01T00:00:00.000Z",
              toolCall: {
                id: "tool_1",
                name: "shell",
                createdAt: "2026-01-01T00:00:00.000Z",
                input: {
                  command: "pwd",
                },
              },
            },
          },
        ],
        listWorklines: () => ({ worklines: [] }),
        listExecutors: () => ({ executors: [] }),
      },
      approvalMode: "never",
      availableSkills: [],
      autoCompactThresholdTokens: 1000,
    });

    expect(state.bookmarks).toEqual(previousState.bookmarks);
    expect(state.sessionGraphEntries).toEqual(previousState.sessionGraphEntries);
    expect(Object.keys(state.pendingApprovals)).toEqual(["executor_helper"]);
    expect(state.activeExecutorId).toBe("executor_main");
  });

  it("loadSupplementalState 会按组件降级并上报局部失败", async () => {
    const refresher = new AppStateRefresher();
    const onPartialFailure = vi.fn();

    const supplemental = await refresher.loadSupplementalState({
      fallbackState: {
        bookmarks: [
          {
            name: "fallback",
            kind: "branch",
            targetNodeId: "node_fallback",
            current: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        sessionGraphEntries: [],
      },
      loadBookmarks: async () => {
        throw new Error("refs broken");
      },
      loadSessionGraphEntries: async () => [
        {
          id: "node_next",
          kind: "message",
          parentNodeIds: ["node_fallback"],
          refs: [],
          summaryTitle: "继续执行",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
      onPartialFailure,
    });

    expect(supplemental.bookmarks).toEqual([
      expect.objectContaining({
        name: "fallback",
      }),
    ]);
    expect(supplemental.sessionGraphEntries).toEqual([
      expect.objectContaining({
        id: "node_next",
      }),
    ]);
    expect(onPartialFailure).toHaveBeenCalledWith(expect.objectContaining({
      component: "bookmarks",
      error: expect.any(Error),
    }));
  });
});
