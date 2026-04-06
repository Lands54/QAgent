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
    listSessionLog: vi.fn(async () => []),
    compactSession,
    createSessionBranch: vi.fn(async () => {
      throw new Error("not used");
    }),
    forkSessionBranch: vi.fn(async () => {
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
});
