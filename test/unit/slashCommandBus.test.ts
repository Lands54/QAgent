import { describe, expect, it, vi } from "vitest";

import { SlashCommandBus } from "../../src/runtime/slashCommandBus.js";
import { SkillRegistry } from "../../src/skills/skillRegistry.js";
import { buildMockSkillResolvedPaths } from "../helpers/mockSkillFixture.js";

function buildSessionDeps() {
  return {
    getSessionGraphStatus: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingSessionId: "session_demo",
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
    createSessionBranch: vi.fn(async () => ({
      mode: "branch" as const,
      name: "feature-a",
      label: "branch=main",
      headNodeId: "node_main",
      workingSessionId: "session_demo",
      dirty: false,
    })),
    forkSessionBranch: vi.fn(async () => ({
      mode: "branch" as const,
      name: "feature-a",
      label: "branch=feature-a",
      headNodeId: "node_main",
      workingSessionId: "session_demo",
      dirty: false,
    })),
    checkoutSessionRef: vi.fn(async () => ({
      ref: {
        mode: "detached-tag" as const,
        name: "baseline",
        label: "detached=tag:baseline",
        headNodeId: "node_main",
        workingSessionId: "session_demo",
        dirty: false,
      },
      message: "已切换到 detached=tag:baseline。\nworking session: session_demo\n工作区未自动回退。",
    })),
    createSessionTag: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingSessionId: "session_demo",
      dirty: false,
    })),
    mergeSessionRef: vi.fn(async () => ({
      mode: "branch" as const,
      name: "main",
      label: "branch=main",
      headNodeId: "node_merge",
      workingSessionId: "session_demo",
      dirty: false,
    })),
  };
}

describe("SlashCommandBus", () => {
  it("支持查看模型状态", async () => {
    const sessionDeps = buildSessionDeps();
    const bus = new SlashCommandBus({
      getSessionId: () => "session_demo",
      getShellCwd: () => "/tmp/project",
      getApprovalMode: () => "always",
      getModelStatus: () => ({
        provider: "openrouter",
        model: "openai/gpt-5",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyMasked: "sk-a...1234",
      }),
      getStatusLine: () => "idle",
      getAvailableSkills: () => [],
      setApprovalMode: vi.fn(async () => {}),
      setModelProvider: vi.fn(async () => {}),
      setModelName: vi.fn(async () => {}),
      setModelApiKey: vi.fn(async () => {}),
      listMemory: vi.fn(async () => []),
      saveMemory: vi.fn(async () => {
        throw new Error("not used");
      }),
      showMemory: vi.fn(async () => undefined),
      interruptAgent: vi.fn(async () => {}),
      resumeAgent: vi.fn(async () => {}),
      ...sessionDeps,
    });

    const result = await bus.execute("/model status");

    expect(result.handled).toBe(true);
    expect(result.messages[0]?.content).toContain("provider: openrouter");
    expect(result.messages[0]?.content).toContain("apiKey: sk-a...1234");
  });

  it("支持通过 slash 更新 provider / model / apikey", async () => {
    const sessionDeps = buildSessionDeps();
    const setModelProvider = vi.fn(async () => {});
    const setModelName = vi.fn(async () => {});
    const setModelApiKey = vi.fn(async () => {});

    const bus = new SlashCommandBus({
      getSessionId: () => "session_demo",
      getShellCwd: () => "/tmp/project",
      getApprovalMode: () => "always",
      getModelStatus: () => ({
        provider: "openai",
        model: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
      }),
      getStatusLine: () => "idle",
      getAvailableSkills: () => [],
      setApprovalMode: vi.fn(async () => {}),
      setModelProvider,
      setModelName,
      setModelApiKey,
      listMemory: vi.fn(async () => []),
      saveMemory: vi.fn(async () => {
        throw new Error("not used");
      }),
      showMemory: vi.fn(async () => undefined),
      interruptAgent: vi.fn(async () => {}),
      resumeAgent: vi.fn(async () => {}),
      ...sessionDeps,
    });

    await bus.execute("/model provider openrouter");
    await bus.execute("/model name openai/gpt-5");
    await bus.execute("/model apikey sk-test-1234");

    expect(setModelProvider).toHaveBeenCalledWith("openrouter");
    expect(setModelName).toHaveBeenCalledWith("openai/gpt-5");
    expect(setModelApiKey).toHaveBeenCalledWith("sk-test-1234");
  });

  it("支持列出并查看 mock skill 元信息", async () => {
    const sessionDeps = buildSessionDeps();
    const registry = new SkillRegistry(buildMockSkillResolvedPaths());
    await registry.refresh();

    const bus = new SlashCommandBus({
      getSessionId: () => "session_demo",
      getShellCwd: () => "/tmp/project",
      getApprovalMode: () => "always",
      getModelStatus: () => ({
        provider: "openai",
        model: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
      }),
      getStatusLine: () => "idle",
      getAvailableSkills: () => registry.getAll(),
      setApprovalMode: vi.fn(async () => {}),
      setModelProvider: vi.fn(async () => {}),
      setModelName: vi.fn(async () => {}),
      setModelApiKey: vi.fn(async () => {}),
      listMemory: vi.fn(async () => []),
      saveMemory: vi.fn(async () => {
        throw new Error("not used");
      }),
      showMemory: vi.fn(async () => undefined),
      interruptAgent: vi.fn(async () => {}),
      resumeAgent: vi.fn(async () => {}),
      ...sessionDeps,
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

  it("支持 session 图命令", async () => {
    const sessionDeps = buildSessionDeps();
    const bus = new SlashCommandBus({
      getSessionId: () => "session_demo",
      getShellCwd: () => "/tmp/project",
      getApprovalMode: () => "always",
      getModelStatus: () => ({
        provider: "openai",
        model: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
      }),
      getStatusLine: () => "idle",
      getAvailableSkills: () => [],
      setApprovalMode: vi.fn(async () => {}),
      setModelProvider: vi.fn(async () => {}),
      setModelName: vi.fn(async () => {}),
      setModelApiKey: vi.fn(async () => {}),
      listMemory: vi.fn(async () => []),
      saveMemory: vi.fn(async () => {
        throw new Error("not used");
      }),
      showMemory: vi.fn(async () => undefined),
      interruptAgent: vi.fn(async () => {}),
      resumeAgent: vi.fn(async () => {}),
      ...sessionDeps,
    });

    const statusResult = await bus.execute("/session status");
    const listResult = await bus.execute("/session list");
    const logResult = await bus.execute("/session log --limit=5");
    const forkResult = await bus.execute("/session fork feature-a");
    const checkoutResult = await bus.execute("/session checkout baseline");

    expect(statusResult.messages[0]?.content).toContain("ref: branch=main");
    expect(listResult.messages[0]?.content).toContain("* main -> node_main");
    expect(logResult.messages[0]?.content).toContain("node_main | root");
    expect(forkResult.messages[0]?.content).toContain("feature-a");
    expect(checkoutResult.messages[0]?.content).toContain("工作区未自动回退");
  });
});
