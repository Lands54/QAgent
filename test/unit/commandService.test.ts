import { describe, expect, it, vi } from "vitest";

import { CommandService, type CommandServiceDependencies } from "../../src/command/index.js";
import type {
  AgentViewState,
  BookmarkListView,
  ExecutorView,
  PendingApprovalCheckpoint,
  UIMessage,
  WorklineView,
} from "../../src/types.js";

function buildAgent(overrides?: Partial<AgentViewState>): AgentViewState {
  const now = "2026-04-07T00:00:00.000Z";
  return {
    id: "agent_main",
    headId: "head_main",
    sessionId: "session_main",
    name: "main",
    kind: "interactive",
    status: "idle",
    autoMemoryFork: true,
    retainOnCompletion: true,
    createdAt: now,
    updatedAt: now,
    detail: "等待输入",
    shellCwd: "/tmp/project",
    dirty: false,
    ...overrides,
  };
}

function buildCheckpoint(): PendingApprovalCheckpoint {
  const now = "2026-04-07T00:00:00.000Z";
  return {
    checkpointId: "approval_1",
    executorId: "agent_main",
    worklineId: "head_main",
    agentId: "agent_main",
    headId: "head_main",
    sessionId: "session_main",
    toolCall: {
      id: "tool_1",
      name: "shell",
      createdAt: now,
      input: {
        command: "pwd",
      },
    },
    approvalRequest: {
      id: "request_1",
      toolCall: {
        id: "tool_1",
        name: "shell",
        createdAt: now,
        input: {
          command: "pwd",
        },
      },
      summary: "需要审批：pwd",
      risk: "high",
      createdAt: now,
    },
    assistantMessageId: "assistant_1",
    createdAt: now,
    resumeState: {
      step: 0,
      toolCalls: [
        {
          id: "tool_1",
          name: "shell",
          createdAt: now,
          input: {
            command: "pwd",
          },
        },
      ],
      nextToolCallIndex: 0,
    },
  };
}

function buildWorkline(overrides?: Partial<WorklineView>): WorklineView {
  return {
    id: "head_main",
    sessionId: "session_main",
    name: "main",
    attachmentMode: "branch",
    attachmentLabel: "branch=main",
    shellCwd: "/tmp/project",
    dirty: false,
    writeLock: "main",
    status: "idle",
    detail: "等待输入",
    executorKind: "interactive",
    active: true,
    ...overrides,
  };
}

function buildExecutor(overrides?: Partial<ExecutorView>): ExecutorView {
  const agent = buildAgent(overrides);
  return {
    ...agent,
    executorId: agent.id,
    worklineId: agent.headId,
    worklineName: agent.name,
    active: true,
  };
}

function createDeps(
  overrides?: Partial<CommandServiceDependencies>,
): CommandServiceDependencies {
  return {
    getSessionId: () => "session_main",
    getActiveHeadId: () => "head_main",
    getActiveAgentId: () => "agent_main",
    getShellCwd: () => "/tmp/project",
    getHookStatus: () => ({
      fetchMemory: true,
      saveMemory: true,
      autoCompact: true,
    }),
    getDebugStatus: async () => ({
      helperAgentAutoCleanup: true,
      helperAgentCount: 0,
      legacyAgentCount: 0,
      uiContextEnabled: false,
    }),
    getApprovalMode: () => "always",
    getModelStatus: () => ({
      provider: "openai",
      model: "test-model",
      baseUrl: "https://example.invalid/v1",
      apiKeyMasked: "***",
    }),
    getStatusLine: () => "status=idle",
    getAvailableSkills: () => [],
    setApprovalMode: async () => {},
    setFetchMemoryHookEnabled: async () => {},
    setSaveMemoryHookEnabled: async () => {},
    setAutoCompactHookEnabled: async () => {},
    setUiContextEnabled: async () => {},
    setHelperAgentAutoCleanupEnabled: async () => {},
    setModelProvider: async () => {},
    setModelName: async () => {},
    setModelApiKey: async () => {},
    listMemory: async () => [],
    saveMemory: async () => ({
      id: "memory_1",
      name: "memory",
      description: "desc",
      content: "content",
      keywords: [],
      scope: "project",
      createdAt: "2026-04-07T00:00:00.000Z",
      updatedAt: "2026-04-07T00:00:00.000Z",
      directoryPath: "/tmp/project/.agent/memory",
      path: "/tmp/project/.agent/memory/memory.md",
    }),
    showMemory: async () => undefined,
    getWorklineStatus: async () => buildWorkline(),
    listWorklines: async () => ({ worklines: [buildWorkline()] }),
    createWorkline: async () => buildWorkline({ id: "head_feature_a", name: "feature-a", attachmentLabel: "branch=feature-a", writeLock: "feature-a" }),
    switchWorkline: async () => buildWorkline({ id: "head_worker", name: "worker" }),
    switchWorklineRelative: async () => buildWorkline({ id: "head_worker", name: "worker" }),
    closeWorkline: async () => buildWorkline({ id: "head_worker", name: "worker", status: "closed", active: false }),
    detachWorkline: async () => buildWorkline({ attachmentMode: "detached-node", attachmentLabel: "detached=node:node_1", writeLock: undefined }),
    mergeWorkline: async () => buildWorkline({ attachmentLabel: "branch=main" }),
    getBookmarkStatus: async () => ({
      current: "branch=main",
      bookmarks: [
        {
          name: "main",
          kind: "branch",
          targetNodeId: "node_1",
          current: true,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
        },
      ] satisfies BookmarkListView["bookmarks"],
    }),
    listBookmarks: async () => ({
      bookmarks: [
        {
          name: "main",
          kind: "branch",
          targetNodeId: "node_1",
          current: true,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
        },
      ],
    }),
    createBookmark: async () => ({
      mode: "branch",
      name: "main",
      label: "branch=main",
      headNodeId: "node_1",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_main",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    }),
    createTagBookmark: async () => ({
      mode: "detached-tag",
      name: "baseline",
      label: "detached=tag:baseline",
      headNodeId: "node_1",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_main",
      active: true,
      dirty: false,
    }),
    switchBookmark: async () => ({
      ref: {
        mode: "branch",
        name: "main",
        label: "branch=main",
        headNodeId: "node_1",
        workingHeadId: "head_main",
        workingHeadName: "main",
        sessionId: "session_main",
        writerLeaseBranch: "main",
        active: true,
        dirty: false,
      },
      message: "已切换到 branch=main。",
    }),
    mergeBookmark: async () => ({
      mode: "branch",
      name: "main",
      label: "branch=main",
      headNodeId: "node_1",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_main",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    }),
    getExecutorStatus: async () => buildExecutor(),
    listExecutors: async () => ({ executors: [buildExecutor()] }),
    interruptExecutor: async () => {},
    resumeExecutor: async () => {},
    listSessionCommits: async () => ({
      commits: [],
    }),
    listSessionGraphLog: async () => [],
    listSessionLog: async () => [],
    compactSession: async () => ({
      compacted: false,
      beforeTokens: 0,
      afterTokens: 0,
      keptGroups: 0,
      removedGroups: 0,
    }),
    resetModelContext: async () => ({
      resetEntryCount: 0,
    }),
    commitSession: async () => ({
      id: "commit_1",
      message: "msg",
      nodeId: "node_1",
      headId: "head_main",
      sessionId: "session_main",
      createdAt: "2026-04-07T00:00:00.000Z",
    }),
    createSessionBranch: async () => ({
      label: "feature",
      refKind: "branch",
      refName: "feature",
      workingHeadId: "head_main",
      sessionId: "session_main",
      nodeId: "node_1",
      attached: true,
      dirty: false,
    }),
    switchSessionCreateBranch: async () => ({
      label: "feature",
      refKind: "branch",
      refName: "feature",
      workingHeadId: "head_main",
      sessionId: "session_main",
      nodeId: "node_1",
      attached: true,
      dirty: false,
    }),
    switchSessionRef: async () => ({
      ref: {
        label: "main",
        refKind: "branch",
        refName: "main",
        workingHeadId: "head_main",
        sessionId: "session_main",
        nodeId: "node_1",
        attached: true,
        dirty: false,
      },
      message: "switched",
    }),
    createSessionTag: async () => ({
      label: "v1",
      refKind: "tag",
      refName: "v1",
      workingHeadId: "head_main",
      sessionId: "session_main",
      nodeId: "node_1",
      attached: true,
      dirty: false,
    }),
    mergeSessionRef: async () => ({
      label: "main",
      refKind: "branch",
      refName: "main",
      workingHeadId: "head_main",
      sessionId: "session_main",
      nodeId: "node_1",
      attached: true,
      dirty: false,
    }),
    forkSessionHead: async () => ({
      label: "worker-a",
      refKind: "head",
      workingHeadId: "head_worker",
      sessionId: "session_worker",
      nodeId: "node_2",
      attached: false,
      dirty: false,
    }),
    switchSessionHead: async () => ({
      label: "worker-a",
      refKind: "head",
      workingHeadId: "head_worker",
      sessionId: "session_worker",
      nodeId: "node_2",
      attached: false,
      dirty: false,
    }),
    attachSessionHead: async () => ({
      label: "worker-a@main",
      refKind: "head",
      workingHeadId: "head_worker",
      sessionId: "session_worker",
      nodeId: "node_2",
      attached: true,
      dirty: false,
    }),
    detachSessionHead: async () => ({
      label: "worker-a",
      refKind: "head",
      workingHeadId: "head_worker",
      sessionId: "session_worker",
      nodeId: "node_2",
      attached: false,
      dirty: false,
    }),
    mergeSessionHead: async () => ({
      label: "main",
      refKind: "branch",
      refName: "main",
      workingHeadId: "head_main",
      sessionId: "session_main",
      nodeId: "node_1",
      attached: true,
      dirty: false,
    }),
    closeSessionHead: async () => ({
      label: "main",
      refKind: "branch",
      refName: "main",
      workingHeadId: "head_main",
      sessionId: "session_main",
      nodeId: "node_1",
      attached: true,
      dirty: false,
    }),
    clearHelperAgents: async () => ({
      cleared: 0,
      skippedRunning: 0,
    }),
    clearLegacyAgents: async () => ({
      cleared: 0,
      skippedRunning: 0,
      skippedActive: 0,
    }),
    clearUi: async () => {},
    runPrompt: async () => ({
      settled: "completed",
      agent: buildAgent(),
      uiMessages: [],
    }),
    getPendingApproval: async () => undefined,
    resolvePendingApproval: async () => ({
      settled: "completed",
      agent: buildAgent(),
      uiMessages: [],
    }),
    ...overrides,
  };
}

describe("CommandService", () => {
  it("run 在 prompt 为空时返回校验错误", async () => {
    const service = new CommandService(createDeps());

    const result = await service.execute({
      domain: "run",
      prompt: "   ",
    });

    expect(result.status).toBe("validation_error");
    expect(result.code).toBe("run.prompt_required");
  });

  it("run 在遇到审批时返回 approval_required 并带 checkpoint", async () => {
    const checkpoint = buildCheckpoint();
    const uiMessages: UIMessage[] = [
      {
        id: "ui_1",
        role: "info",
        content: "等待审批",
        createdAt: "2026-04-07T00:00:00.000Z",
      },
    ];
    const service = new CommandService(createDeps({
      runPrompt: async () => ({
        settled: "approval_required",
        agent: buildAgent({
          status: "awaiting-approval",
          detail: "等待审批",
          pendingApproval: checkpoint.approvalRequest,
        }),
        checkpoint,
        uiMessages,
      }),
    }));

    const result = await service.execute({
      domain: "run",
      prompt: "请执行命令",
    });

    expect(result.status).toBe("approval_required");
    expect(result.code).toBe("approval.required");
    expect((result.payload as { checkpoint: PendingApprovalCheckpoint }).checkpoint.checkpointId).toBe("approval_1");
  });

  it("approval status 会返回当前 checkpoint 信息", async () => {
    const checkpoint = buildCheckpoint();
    const service = new CommandService(createDeps({
      getPendingApproval: async () => checkpoint,
    }));

    const result = await service.execute({
      domain: "approval",
      action: "status",
    });

    expect(result.status).toBe("success");
    expect(result.code).toBe("approval.status");
    expect((result.payload as { checkpoint: PendingApprovalCheckpoint }).checkpoint?.checkpointId).toBe("approval_1");
    expect(result.messages[0]?.text).toContain("checkpoint: approval_1");
  });

  it("approval approve 成功后会透传恢复结果", async () => {
    const resolvePendingApproval = vi.fn(async () => ({
      settled: "completed" as const,
      agent: buildAgent(),
      uiMessages: [
        {
          id: "ui_tool",
          role: "tool" as const,
          content: "$ pwd",
          createdAt: "2026-04-07T00:00:00.000Z",
        },
      ],
    }));
    const service = new CommandService(createDeps({
      resolvePendingApproval,
    }));

    const result = await service.execute({
      domain: "approval",
      action: "approve",
      checkpointId: "approval_1",
    });

    expect(resolvePendingApproval).toHaveBeenCalledWith(true, {
      checkpointId: "approval_1",
      agentId: undefined,
      headId: undefined,
    });
    expect(result.status).toBe("success");
    expect(result.code).toBe("approval.approved");
    expect(((result.payload as { uiMessages: UIMessage[] }).uiMessages)[0]?.content).toBe("$ pwd");
  });

  it("memory show 未找到时返回非 0 结果", async () => {
    const service = new CommandService(createDeps({
      showMemory: async () => undefined,
    }));

    const result = await service.execute({
      domain: "memory",
      action: "show",
      name: "missing-memory",
    });

    expect(result.status).toBe("runtime_error");
    expect(result.exitCode).toBe(1);
    expect(result.code).toBe("memory.not_found");
    expect(result.messages[0]?.text).toContain("missing-memory");
  });

  it("skills show 未找到时返回非 0 结果", async () => {
    const service = new CommandService(createDeps({
      getAvailableSkills: () => [],
    }));

    const result = await service.execute({
      domain: "skills",
      action: "show",
      key: "missing-skill",
    });

    expect(result.status).toBe("runtime_error");
    expect(result.exitCode).toBe(1);
    expect(result.code).toBe("skills.not_found");
    expect(result.messages[0]?.text).toContain("missing-skill");
  });

  it("会把异步命令执行错误包装成 runtime_error 结果", async () => {
    const service = new CommandService(createDeps({
      createBookmark: async () => {
        throw new Error("branch 名称必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/u。");
      },
    }));

    const result = await service.execute({
      domain: "bookmark",
      action: "save",
      name: "Foo",
    });

    expect(result.status).toBe("runtime_error");
    expect(result.code).toBe("command.runtime_error");
    expect(result.messages[0]?.text).toContain("branch 名称必须匹配");
  });
});
