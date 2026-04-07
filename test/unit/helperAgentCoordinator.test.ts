import { describe, expect, it, vi } from "vitest";

import { HelperAgentCoordinator } from "../../src/runtime/application/helperAgentCoordinator.js";

describe("HelperAgentCoordinator", () => {
  it("在开启自动清理时会清理执行完成的 helper agent", async () => {
    const cleanupCompletedAgent = vi.fn(async () => {});
    const coordinator = new HelperAgentCoordinator({
      spawnTaskAgent: vi.fn(async () => ({ id: "helper-1" })),
      submitInputToAgent: vi.fn(async () => {}),
      getRuntime: vi.fn(() => ({
        getHead: vi.fn(),
        getSnapshot: vi.fn(),
      })),
      cleanupCompletedAgent,
      shouldAutoCleanupHelperAgent: () => true,
    });

    const result = await coordinator.run({
      name: "helper-1",
      retainOnCompletion: false,
      readResult: async () => "ok",
    });

    expect(result.agentId).toBe("helper-1");
    expect(result.result).toBe("ok");
    expect(cleanupCompletedAgent).toHaveBeenCalledWith("helper-1");
  });

  it("在关闭自动清理时会保留执行完成的 helper agent", async () => {
    const cleanupCompletedAgent = vi.fn(async () => {});
    const coordinator = new HelperAgentCoordinator({
      spawnTaskAgent: vi.fn(async () => ({ id: "helper-2" })),
      submitInputToAgent: vi.fn(async () => {}),
      getRuntime: vi.fn(() => ({
        getHead: vi.fn(),
        getSnapshot: vi.fn(),
      })),
      cleanupCompletedAgent,
      shouldAutoCleanupHelperAgent: () => false,
    });

    const result = await coordinator.run({
      name: "helper-2",
      retainOnCompletion: false,
      readResult: async () => "ok",
    });

    expect(result.agentId).toBe("helper-2");
    expect(result.result).toBe("ok");
    expect(cleanupCompletedAgent).not.toHaveBeenCalled();
  });
});
