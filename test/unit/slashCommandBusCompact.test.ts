import { describe, expect, it, vi } from "vitest";

import { SlashCommandBus } from "../../src/runtime/slashCommandBus.js";

function buildBus() {
  const setAutoCompactHookEnabled = vi.fn(async () => {});
  const compactSession = vi.fn(async () => ({
    compacted: true,
    agentId: "head_compact",
    beforeTokens: 1800,
    afterTokens: 420,
    keptGroups: 1,
    removedGroups: 3,
  }));
  const resetModelContext = vi.fn(async () => ({
    resetEntryCount: 2,
  }));

  const bus = new SlashCommandBus({
    getSessionId: () => "session_demo",
    getActiveHeadId: () => "head_main",
    getActiveAgentId: () => "head_main",
    getShellCwd: () => "/tmp/project",
    getHookStatus: () => ({
      fetchMemory: true,
      saveMemory: true,
      autoCompact: false,
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
    setAutoCompactHookEnabled,
    setHelperAgentAutoCleanupEnabled: vi.fn(async () => {}),
    setModelProvider: vi.fn(async () => {}),
    setModelName: vi.fn(async () => {}),
    setModelApiKey: vi.fn(async () => {}),
    listMemory: vi.fn(async () => []),
    saveMemory: vi.fn(async () => {
      throw new Error("not used");
    }),
    showMemory: vi.fn(async () => undefined),
    getAgentStatus: vi.fn(async () => {
      throw new Error("not used");
    }),
    listAgents: vi.fn(async () => []),
    spawnAgent: vi.fn(async () => {
      throw new Error("not used");
    }),
    switchAgent: vi.fn(async () => {
      throw new Error("not used");
    }),
    switchAgentRelative: vi.fn(async () => {
      throw new Error("not used");
    }),
    closeAgent: vi.fn(async () => {
      throw new Error("not used");
    }),
    interruptAgent: vi.fn(async () => {}),
    resumeAgent: vi.fn(async () => {}),
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
      branches: [],
      tags: [],
    })),
    listSessionHeads: vi.fn(async () => ({
      heads: [],
    })),
    listSessionCommits: vi.fn(async () => ({
      commits: [],
    })),
    listSessionGraphLog: vi.fn(async () => []),
    listSessionLog: vi.fn(async () => []),
    compactSession,
    resetModelContext,
    commitSession: vi.fn(async () => {
      throw new Error("not used");
    }),
    clearHelperAgents: vi.fn(async () => ({
      cleared: 0,
      skippedRunning: 0,
    })),
    clearLegacyAgents: vi.fn(async () => ({
      cleared: 0,
      skippedRunning: 0,
      skippedActive: 0,
    })),
    createSessionBranch: vi.fn(async () => {
      throw new Error("not used");
    }),
    switchSessionCreateBranch: vi.fn(async () => {
      throw new Error("not used");
    }),
    forkSessionBranch: vi.fn(async () => {
      throw new Error("not used");
    }),
    switchSessionRef: vi.fn(async () => {
      throw new Error("not used");
    }),
    checkoutSessionRef: vi.fn(async () => {
      throw new Error("not used");
    }),
    createSessionTag: vi.fn(async () => {
      throw new Error("not used");
    }),
    mergeSessionRef: vi.fn(async () => {
      throw new Error("not used");
    }),
    forkSessionHead: vi.fn(async () => {
      throw new Error("not used");
    }),
    switchSessionHead: vi.fn(async () => {
      throw new Error("not used");
    }),
    attachSessionHead: vi.fn(async () => {
      throw new Error("not used");
    }),
    detachSessionHead: vi.fn(async () => {
      throw new Error("not used");
    }),
    mergeSessionHead: vi.fn(async () => {
      throw new Error("not used");
    }),
    closeSessionHead: vi.fn(async () => {
      throw new Error("not used");
    }),
  });

  return {
    bus,
    setAutoCompactHookEnabled,
    compactSession,
    resetModelContext,
  };
}

describe("SlashCommandBus compact commands", () => {
  it("支持 auto-compact hook 开关", async () => {
    const { bus, setAutoCompactHookEnabled } = buildBus();

    const result = await bus.execute("/hook auto-compact on");

    expect(setAutoCompactHookEnabled).toHaveBeenCalledWith(true);
    expect(result.messages[0]?.content).toContain("auto-compact hook 已切换为 on");
  });

  it("支持 /session compact 并返回压缩统计", async () => {
    const { bus, compactSession } = buildBus();

    const result = await bus.execute("/session compact");

    expect(compactSession).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.messages[0]?.content).toContain("已完成 compact");
    expect(result.messages[0]?.content).toContain("before=1800 after=420");
    expect(result.messages[0]?.content).toContain("压缩分组=3");
    expect(result.messages[0]?.content).toContain("保留分组=1");
  });

  it("支持 /session reset-context 并只重置模型上下文", async () => {
    const { bus, resetModelContext } = buildBus();

    const result = await bus.execute("/session reset-context");

    expect(resetModelContext).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.messages[0]?.content).toContain("已重置当前 working snapshot 的模型上下文");
    expect(result.messages[0]?.content).toContain("UI 历史与既有节点保持不变");
  });
});
