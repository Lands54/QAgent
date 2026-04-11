import { describe, expect, it, vi } from "vitest";

import { SlashCommandBus } from "../../src/runtime/slashCommandBus.js";
import { SkillRegistry } from "../../src/skills/skillRegistry.js";
import type { MemoryRecord } from "../../src/types.js";
import { buildMockSkillResolvedPaths } from "../helpers/mockSkillFixture.js";

type SlashCommandDeps = ConstructorParameters<typeof SlashCommandBus>[0];

function buildSessionDeps(): Pick<
  SlashCommandDeps,
  | "getSessionGraphStatus"
  | "listSessionRefs"
  | "listSessionCommits"
  | "listSessionGraphLog"
  | "listSessionLog"
  | "commitSession"
  | "createSessionBranch"
  | "switchSessionCreateBranch"
  | "forkSessionBranch"
  | "switchSessionRef"
  | "checkoutSessionRef"
  | "createSessionTag"
  | "mergeSessionRef"
  | "listSessionHeads"
  | "forkSessionHead"
  | "switchSessionHead"
  | "attachSessionHead"
  | "detachSessionHead"
  | "mergeSessionHead"
  | "closeSessionHead"
> {
  return {
    getSessionGraphStatus: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    listSessionRefs: vi.fn(async () => ({
      branches: [
        {
          name: "main",
          targetNodeId: "node_main",
          current: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      tags: [
        {
          name: "baseline",
          targetNodeId: "node_main",
          current: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })),
    listSessionLog: vi.fn(async () => [
      {
        id: "node_main",
        kind: "root" as const,
        parentNodeIds: [],
        refs: ["branch:main"],
        summaryTitle: "root:node_main",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
    listSessionCommits: vi.fn(async () => ({
      commits: [
        {
          id: "commit_main",
          message: "初始化 session graph",
          nodeId: "node_main",
          headId: "head_main",
          sessionId: "session_demo",
          createdAt: "2026-01-01T00:00:00.000Z",
          current: true,
        },
      ],
    })),
    listSessionGraphLog: vi.fn(async () => [
      {
        id: "node_main",
        kind: "root" as const,
        parentNodeIds: [],
        refs: ["branch:main"],
        summaryTitle: "root:node_main",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
    commitSession: vi.fn(async () => ({
      id: "commit_feature_a",
      message: "保存当前方案",
      nodeId: "node_commit",
      headId: "head_main",
      sessionId: "session_demo",
      createdAt: "2026-01-02T00:00:00.000Z",
    })),
    createSessionBranch: vi.fn(async () => ({
      mode: "branch" as const,
      name: "feature-a",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    forkSessionBranch: vi.fn(async () => ({
      mode: "branch" as const,
      name: "feature-a",
      label: "branch=feature-a",
      headNodeId: "node_main",
      workingHeadId: "head_feature_a",
      workingHeadName: "feature-a",
      sessionId: "session_feature_a",
      writerLeaseBranch: "feature-a",
      active: true,
      dirty: false,
    })),
    switchSessionCreateBranch: vi.fn(async () => ({
      mode: "branch" as const,
      name: "feature-a",
      label: "branch=feature-a",
      headNodeId: "node_main",
      workingHeadId: "head_feature_a",
      workingHeadName: "feature-a",
      sessionId: "session_feature_a",
      writerLeaseBranch: "feature-a",
      active: true,
      dirty: false,
    })),
    checkoutSessionRef: vi.fn(async () => ({
      ref: {
        mode: "detached-tag" as const,
        name: "baseline",
        label: "detached=tag:baseline",
        headNodeId: "node_main",
        workingHeadId: "head_main",
        workingHeadName: "main",
        sessionId: "session_demo",
        active: true,
        dirty: false,
      },
      message: "已切换到 detached=tag:baseline。\nworking session: session_demo\n工作区未自动回退。",
    })),
    switchSessionRef: vi.fn(async () => ({
      ref: {
        mode: "detached-tag" as const,
        name: "baseline",
        label: "detached=tag:baseline",
        headNodeId: "node_main",
        workingHeadId: "head_main",
        workingHeadName: "main",
        sessionId: "session_demo",
        active: true,
        dirty: false,
      },
      message: "已切换到 detached=tag:baseline。\nworking head: main\n工作区未自动回退。",
    })),
    createSessionTag: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    mergeSessionRef: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_merge",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    listSessionHeads: vi.fn(async () => ({
      heads: [
        {
          id: "head_main",
          name: "main",
          sessionId: "session_demo",
          attachmentLabel: "branch=main",
          currentNodeId: "node_main",
          writerLeaseBranch: "main",
          active: true,
          status: "idle" as const,
          dirty: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })),
    forkSessionHead: vi.fn(async () => ({
      mode: "detached-node" as const,
      name: "worker-a",
      label: "detached=node:node_main",
      headNodeId: "node_main",
      workingHeadId: "head_worker_a",
      workingHeadName: "worker-a",
      sessionId: "session_worker_a",
      active: false,
      dirty: false,
    })),
    switchSessionHead: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    attachSessionHead: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_worker_a",
      workingHeadName: "worker-a",
      sessionId: "session_worker_a",
      writerLeaseBranch: "main",
      active: false,
      dirty: false,
    })),
    detachSessionHead: vi.fn(async () => ({
      mode: "detached-node" as const,
      name: "node_main",
      label: "detached=node:node_main",
      headNodeId: "node_main",
      workingHeadId: "head_worker_a",
      workingHeadName: "worker-a",
      sessionId: "session_worker_a",
      active: false,
      dirty: false,
    })),
    mergeSessionHead: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_merge",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    closeSessionHead: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
  };
}

function buildBus(
  overrides: Partial<SlashCommandDeps> = {},
): {
  bus: SlashCommandBus;
  deps: SlashCommandDeps;
} {
  const deps: SlashCommandDeps = {
    getSessionId: () => "session_demo",
    getActiveHeadId: () => "head_main",
    getActiveAgentId: () => "head_main",
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
      model: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
    }),
    getStatusLine: () => "idle",
    getAvailableSkills: () => [],
    setApprovalMode: vi.fn(async () => {}),
    setFetchMemoryHookEnabled: vi.fn(async () => {}),
    setSaveMemoryHookEnabled: vi.fn(async () => {}),
    setAutoCompactHookEnabled: vi.fn(async () => {}),
    setUiContextEnabled: vi.fn(async () => {}),
    setHelperAgentAutoCleanupEnabled: vi.fn(async () => {}),
    setModelProvider: vi.fn(async () => {}),
    setModelName: vi.fn(async () => {}),
    setModelApiKey: vi.fn(async () => {}),
    listMemory: vi.fn(async () => []),
    saveMemory: vi.fn(async () => {
      throw new Error("not used");
    }),
    showMemory: vi.fn(async () => undefined),
    getWorklineStatus: vi.fn(async () => ({
      id: "head_main",
      sessionId: "session_demo",
      name: "main",
      attachmentMode: "branch",
      attachmentLabel: "branch=main",
      shellCwd: "/tmp/project",
      dirty: false,
      writeLock: "main",
      status: "idle",
      detail: "idle",
      executorKind: "interactive",
      active: true,
    })),
    listWorklines: vi.fn(async () => ({
      worklines: [
        {
          id: "head_main",
          sessionId: "session_demo",
          name: "main",
          attachmentMode: "branch",
          attachmentLabel: "branch=main",
          shellCwd: "/tmp/project",
          dirty: false,
          writeLock: "main",
          status: "idle",
          detail: "idle",
          executorKind: "interactive",
          active: true,
        },
      ],
    })),
    createWorkline: vi.fn(async () => ({
      id: "head_feature_a",
      sessionId: "session_feature_a",
      name: "feature-a",
      attachmentMode: "branch",
      attachmentLabel: "branch=feature-a",
      shellCwd: "/tmp/project",
      dirty: false,
      writeLock: "feature-a",
      status: "idle",
      detail: "idle",
      executorKind: "interactive",
      active: true,
    })),
    switchWorkline: vi.fn(async () => ({
      id: "head_feature_a",
      sessionId: "session_feature_a",
      name: "feature-a",
      attachmentMode: "branch",
      attachmentLabel: "branch=feature-a",
      shellCwd: "/tmp/project",
      dirty: false,
      writeLock: "feature-a",
      status: "idle",
      detail: "idle",
      executorKind: "interactive",
      active: true,
    })),
    switchWorklineRelative: vi.fn(async () => ({
      id: "head_feature_a",
      sessionId: "session_feature_a",
      name: "feature-a",
      attachmentMode: "branch",
      attachmentLabel: "branch=feature-a",
      shellCwd: "/tmp/project",
      dirty: false,
      writeLock: "feature-a",
      status: "idle",
      detail: "idle",
      executorKind: "interactive",
      active: true,
    })),
    closeWorkline: vi.fn(async () => ({
      id: "head_worker",
      sessionId: "session_worker",
      name: "worker",
      attachmentMode: "detached-node",
      attachmentLabel: "closed",
      shellCwd: "/tmp/project",
      dirty: false,
      status: "closed",
      detail: "closed",
      executorKind: "interactive",
      active: false,
    })),
    detachWorkline: vi.fn(async () => ({
      id: "head_main",
      sessionId: "session_demo",
      name: "main",
      attachmentMode: "detached-node",
      attachmentLabel: "detached=node:node_main",
      shellCwd: "/tmp/project",
      dirty: false,
      status: "idle",
      detail: "idle",
      executorKind: "interactive",
      active: true,
    })),
    mergeWorkline: vi.fn(async () => ({
      id: "head_main",
      sessionId: "session_demo",
      name: "main",
      attachmentMode: "branch",
      attachmentLabel: "branch=main",
      shellCwd: "/tmp/project",
      dirty: false,
      writeLock: "main",
      status: "idle",
      detail: "idle",
      executorKind: "interactive",
      active: true,
    })),
    getBookmarkStatus: vi.fn(async () => ({
      current: "branch=main",
      bookmarks: [
        {
          name: "main",
          kind: "branch",
          targetNodeId: "node_main",
          current: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          name: "baseline",
          kind: "tag",
          targetNodeId: "node_main",
          current: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })),
    listBookmarks: vi.fn(async () => ({
      bookmarks: [
        {
          name: "main",
          kind: "branch",
          targetNodeId: "node_main",
          current: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          name: "baseline",
          kind: "tag",
          targetNodeId: "node_main",
          current: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })),
    createBookmark: vi.fn(async () => ({
      mode: "branch" as const,
      name: "feature-a",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    createTagBookmark: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    switchBookmark: vi.fn(async () => ({
      ref: {
        mode: "detached-tag" as const,
        name: "baseline",
        label: "detached=tag:baseline",
        headNodeId: "node_main",
        workingHeadId: "head_main",
        workingHeadName: "main",
        sessionId: "session_demo",
        active: true,
        dirty: false,
      },
      message: "已切换到 detached=tag:baseline。\nworking head: main\n工作区未自动回退。",
    })),
    mergeBookmark: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_merge",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    })),
    getExecutorStatus: vi.fn(async () => ({
      id: "head_main",
      headId: "head_main",
      sessionId: "session_demo",
      name: "main",
      kind: "interactive",
      status: "idle",
      autoMemoryFork: true,
      retainOnCompletion: true,
      detail: "idle",
      shellCwd: "/tmp/project",
      dirty: false,
      executorId: "head_main",
      worklineId: "head_main",
      worklineName: "main",
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    listExecutors: vi.fn(async () => ({
      executors: [],
    })),
    interruptExecutor: vi.fn(async () => {}),
    resumeExecutor: vi.fn(async () => {}),
    compactSession: vi.fn(async () => ({
      compacted: true,
      agentId: "head_compact",
      beforeTokens: 1800,
      afterTokens: 420,
      keptGroups: 1,
      removedGroups: 3,
    })),
    resetModelContext: vi.fn(async () => ({
      resetEntryCount: 0,
    })),
    clearHelperAgents: vi.fn(async () => ({
      cleared: 0,
      skippedRunning: 0,
    })),
    clearLegacyAgents: vi.fn(async () => ({
      cleared: 0,
      skippedRunning: 0,
      skippedActive: 0,
    })),
    ...buildSessionDeps(),
    ...overrides,
  };

  return {
    bus: new SlashCommandBus(deps),
    deps,
  };
}

describe("SlashCommandBus", () => {
  it("支持查看模型状态", async () => {
    const { bus } = buildBus({
      getModelStatus: () => ({
        provider: "openrouter",
        model: "openai/gpt-5",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyMasked: "sk-a...1234",
      }),
    });

    const result = await bus.execute("/model status");

    expect(result.handled).toBe(true);
    expect(result.messages[0]?.content).toContain("provider: openrouter");
    expect(result.messages[0]?.content).toContain("apiKey: sk-a...1234");
  });

  it("支持通过 slash 更新 provider / model / apikey", async () => {
    const setModelProvider = vi.fn(async () => {});
    const setModelName = vi.fn(async () => {});
    const setModelApiKey = vi.fn(async () => {});
    const { bus } = buildBus({
      setModelProvider,
      setModelName,
      setModelApiKey,
    });

    await bus.execute("/model provider openrouter");
    await bus.execute("/model name openai/gpt-5");
    await bus.execute("/model apikey sk-test-1234");

    expect(setModelProvider).toHaveBeenCalledWith("openrouter");
    expect(setModelName).toHaveBeenCalledWith("openai/gpt-5");
    expect(setModelApiKey).toHaveBeenCalledWith("sk-test-1234");
  });

  it("支持 debug ui-context 开关与状态查询", async () => {
    const setUiContextEnabled = vi.fn(async () => {});
    const { bus } = buildBus({
      setUiContextEnabled,
      getDebugStatus: async () => ({
        helperAgentAutoCleanup: true,
        helperAgentCount: 1,
        legacyAgentCount: 2,
        uiContextEnabled: true,
      }),
    });

    const statusResult = await bus.execute("/debug ui-context status");
    await bus.execute("/debug ui-context on");
    await bus.execute("/debug ui-context off");

    expect(statusResult.messages[0]?.content).toContain("ui-context: on");
    expect(setUiContextEnabled).toHaveBeenNthCalledWith(1, true);
    expect(setUiContextEnabled).toHaveBeenNthCalledWith(2, false);
  });

  it("支持新的 memory save/list/show 语法", async () => {
    const savedRecord: MemoryRecord = {
      id: "reply-language",
      name: "reply-language",
      description: "偏好使用中文回复",
      content: "请始终使用中文回复。",
      keywords: ["reply-language", "中文"],
      scope: "project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      directoryPath: "/tmp/project/.agent/memory/reply-language",
      path: "/tmp/project/.agent/memory/reply-language/MEMORY.md",
    };
    const listMemory = vi.fn(async () => [savedRecord]);
    const saveMemory = vi.fn(async () => savedRecord);
    const showMemory = vi.fn(async () => savedRecord);
    const { bus } = buildBus({
      listMemory,
      saveMemory,
      showMemory,
    });

    const saveResult = await bus.execute(
      '/memory save --name=reply-language --description="偏好使用中文回复" 请始终使用中文回复。',
    );
    const listResult = await bus.execute("/memory list");
    const showResult = await bus.execute("/memory show reply-language");

    expect(saveMemory).toHaveBeenCalledWith({
      name: "reply-language",
      description: "偏好使用中文回复",
      content: "请始终使用中文回复。",
      scope: "project",
    });
    expect(showMemory).toHaveBeenCalledWith("reply-language");
    expect(saveResult.messages[0]?.content).toContain("已保存 memory：reply-language");
    expect(listResult.messages[0]?.content).toContain(
      "reply-language | project | 偏好使用中文回复",
    );
    expect(showResult.messages[0]?.content).toContain("name: reply-language");
    expect(showResult.messages[0]?.content).toContain("description: 偏好使用中文回复");
    expect(showResult.messages[0]?.content).toContain("MEMORY.md");
  });

  it("支持查看并切换 helper hooks", async () => {
    const setFetchMemoryHookEnabled = vi.fn(async () => {});
    const setSaveMemoryHookEnabled = vi.fn(async () => {});
    const setAutoCompactHookEnabled = vi.fn(async () => {});
    const { bus } = buildBus({
      getHookStatus: () => ({
        fetchMemory: true,
        saveMemory: false,
        autoCompact: true,
      }),
      setFetchMemoryHookEnabled,
      setSaveMemoryHookEnabled,
      setAutoCompactHookEnabled,
    });

    const statusResult = await bus.execute("/hook status");
    const fetchResult = await bus.execute("/hook fetch-memory off");
    const saveResult = await bus.execute("/hook save-memory on");
    const compactResult = await bus.execute("/hook auto-compact off");

    expect(statusResult.messages[0]?.content).toContain("fetch-memory: on");
    expect(statusResult.messages[0]?.content).toContain("save-memory: off");
    expect(statusResult.messages[0]?.content).toContain("auto-compact: on");
    expect(setFetchMemoryHookEnabled).toHaveBeenCalledWith(false);
    expect(setSaveMemoryHookEnabled).toHaveBeenCalledWith(true);
    expect(setAutoCompactHookEnabled).toHaveBeenCalledWith(false);
    expect(fetchResult.messages[0]?.content).toContain("fetch-memory hook 已切换为 off");
    expect(saveResult.messages[0]?.content).toContain("save-memory hook 已切换为 on");
    expect(compactResult.messages[0]?.content).toContain("auto-compact hook 已切换为 off");
  });

  it("支持 helper agent debug 命令", async () => {
    const getDebugStatus = vi.fn(async () => ({
      helperAgentAutoCleanup: false,
      helperAgentCount: 3,
      legacyAgentCount: 2,
      uiContextEnabled: false,
    }));
    const setHelperAgentAutoCleanupEnabled = vi.fn(async () => {});
    const clearHelperAgents = vi.fn(async () => ({
      cleared: 2,
      skippedRunning: 1,
    }));
    const { bus } = buildBus({
      getDebugStatus,
      setHelperAgentAutoCleanupEnabled,
      clearHelperAgents,
    });

    const statusResult = await bus.execute("/debug helper-agent status");
    const toggleResult = await bus.execute("/debug helper-agent autocleanup on");
    const clearResult = await bus.execute("/debug helper-agent clear");

    expect(getDebugStatus).toHaveBeenCalledTimes(1);
    expect(statusResult.messages[0]?.content).toContain(
      "helper-agent autocleanup: off",
    );
    expect(statusResult.messages[0]?.content).toContain("helper-agent count: 3");
    expect(statusResult.messages[0]?.content).toContain("legacy-agent count: 2");
    expect(setHelperAgentAutoCleanupEnabled).toHaveBeenCalledWith(true);
    expect(toggleResult.messages[0]?.content).toContain(
      "helper-agent autocleanup 已切换为 on",
    );
    expect(clearHelperAgents).toHaveBeenCalledTimes(1);
    expect(clearResult.messages[0]?.content).toContain("已清理 2 个 helper agent");
    expect(clearResult.messages[0]?.content).toContain("跳过 1 个运行中的 helper agent");
  });

  it("支持清理 legacy agent", async () => {
    const clearLegacyAgents = vi.fn(async () => ({
      cleared: 3,
      skippedRunning: 1,
      skippedActive: 1,
    }));
    const { bus } = buildBus({
      clearLegacyAgents,
    });

    const result = await bus.execute("/debug legacy clear");

    expect(clearLegacyAgents).toHaveBeenCalledTimes(1);
    expect(result.messages[0]?.content).toContain("已清理 3 个 legacy agent");
    expect(result.messages[0]?.content).toContain("跳过 1 个运行中的 legacy agent");
    expect(result.messages[0]?.content).toContain("跳过 1 个当前激活的 legacy agent");
  });

  it("支持列出并查看 mock skill 元信息", async () => {
    const registry = new SkillRegistry(buildMockSkillResolvedPaths());
    await registry.refresh();
    const { bus } = buildBus({
      getAvailableSkills: () => registry.getAll(),
    });

    const listResult = await bus.execute("/skills list");
    const showResult = await bus.execute("/skills show pdf-processing");

    expect(listResult.messages[0]?.content).toContain("project:pdf-processing");
    expect(listResult.messages[0]?.content).toContain("global:api-testing");
    expect(listResult.messages[0]?.content).not.toContain("bad-Uppercase");
    expect(showResult.messages[0]?.content).toContain("description:");
    expect(showResult.messages[0]?.content).toContain("SKILL.md");
    expect(showResult.messages[0]?.content).toContain("不需要手动激活");
  });

  it("支持新的 work / bookmark 命令", async () => {
    const { bus } = buildBus();

    const statusResult = await bus.execute("/work status");
    const workListResult = await bus.execute("/work list");
    const bookmarkListResult = await bus.execute("/bookmark list");
    const commitResult = await bus.execute('/session commit -m "保存当前方案"');
    const logResult = await bus.execute("/session log --limit=5");
    const graphLogResult = await bus.execute("/session graph log --limit=5");
    const workCreateResult = await bus.execute("/work new feature-a");
    const switchResult = await bus.execute("/bookmark switch baseline");

    expect(statusResult.messages[0]?.content).toContain("bookmark=branch=main");
    expect(workListResult.messages[0]?.content).toContain("name=main");
    expect(bookmarkListResult.messages[0]?.content).toContain("branch | main -> node_main");
    expect(bookmarkListResult.messages[0]?.content).toContain("tag | baseline -> node_main");
    expect(commitResult.messages[0]?.content).toContain("commit_feature_a");
    expect(logResult.messages[0]?.content).toContain("commit_main | 初始化 session graph | node_main");
    expect(graphLogResult.messages[0]?.content).toContain("node_main | root");
    expect(workCreateResult.messages[0]?.content).toContain("feature-a");
    expect(switchResult.messages[0]?.content).toContain("工作区未自动回退");
  });

  it("旧的 session 命令会返回迁移提示", async () => {
    const { bus } = buildBus();

    const listResult = await bus.execute("/session list");
    const forkResult = await bus.execute("/session fork feature-a");
    const checkoutResult = await bus.execute("/session checkout baseline");

    expect(listResult.messages[0]?.content).toContain("/bookmark list");
    expect(forkResult.messages[0]?.content).toContain("/work new");
    expect(checkoutResult.messages[0]?.content).toContain("/bookmark switch");
  });

  it("旧的 working head 命令会返回迁移提示", async () => {
    const { bus } = buildBus();

    const listResult = await bus.execute("/session head list");
    const forkResult = await bus.execute("/session head fork worker-a");
    const detachResult = await bus.execute("/session head detach head_worker_a");

    expect(listResult.messages[0]?.content).toContain("/work");
    expect(forkResult.messages[0]?.content).toContain("/work");
    expect(detachResult.messages[0]?.content).toContain("/work");
  });
});
