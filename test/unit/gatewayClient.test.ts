import { describe, expect, it, vi } from "vitest";

import { BackendClientController } from "../../src/gateway/gatewayClient.js";
import { createEmptyState } from "../../src/runtime/index.js";

class TestBackendClientController extends BackendClientController {
  public constructor(transport: object) {
    super(transport as never, "client_test", {
      ...createEmptyState("/tmp/project"),
      status: {
        mode: "idle",
        detail: "等待输入",
        updatedAt: new Date().toISOString(),
      },
    });
  }

  public async startEventStreamForTest(): Promise<void> {
    await (this as unknown as { startEventStream: () => Promise<void> }).startEventStream();
  }
}

function createTransportStub(input?: {
  submitInput?: () => Promise<{ exitRequested?: boolean }>;
  openEventStream?: () => Promise<void>;
}) {
  return {
    openClient: vi.fn(),
    submitInput: vi.fn(input?.submitInput ?? (async () => ({ handled: false }))),
    executeCommand: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    closeClient: vi.fn(async () => {}),
    openEventStream: vi.fn(input?.openEventStream ?? (async () => {})),
    heartbeatExecutor: vi.fn(async () => {}),
  };
}

describe("BackendClientController", () => {
  it("gateway submitInput 断连时会转成 UI 错误，而不是让 Promise reject", async () => {
    const transport = createTransportStub({
      submitInput: async () => {
        const cause = new Error("other side closed");
        Object.assign(cause, {
          code: "UND_ERR_SOCKET",
        });
        const error = new TypeError("fetch failed");
        Object.assign(error, {
          cause,
        });
        throw error;
      },
    });
    const controller = new TestBackendClientController(transport);

    try {
      await expect(controller.submitInput("hello")).resolves.toBeUndefined();

      const state = controller.getState();
      expect(state.status.mode).toBe("error");
      expect(state.status.detail).toContain("与 gateway 的连接已断开");
      expect(state.uiMessages.at(-1)?.title).toBe("Gateway");
      expect(state.uiMessages.at(-1)?.content).toContain("发送输入失败");
    } finally {
      await controller.dispose();
    }
  });

  it("事件流意外关闭时会把断连状态反映到 UI", async () => {
    const transport = createTransportStub({
      openEventStream: async () => {},
    });
    const controller = new TestBackendClientController(transport);

    try {
      await controller.startEventStreamForTest();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const state = controller.getState();
      expect(state.status.mode).toBe("error");
      expect(state.uiMessages.at(-1)?.content).toContain("监听事件流失败");
    } finally {
      await controller.dispose();
    }
  });
});
