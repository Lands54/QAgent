import { describe, expect, it, vi } from "vitest";

import { BackendClientController } from "../../src/gateway/gatewayClient.js";
import { createEmptyState, type AppState } from "../../src/runtime/index.js";

class TestBackendClientController extends BackendClientController {
  public constructor(transport: object, state?: AppState) {
    super(transport as never, "client_test", state ?? {
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

  public startHeartbeatForTest(): void {
    (this as unknown as { startHeartbeat: () => void }).startHeartbeat();
  }
}

function createTransportStub(input?: {
  submitInput?: () => Promise<{ exitRequested?: boolean }>;
  openEventStream?: (signal: AbortSignal) => Promise<void>;
  closeClient?: (signal?: AbortSignal) => Promise<void>;
}) {
  return {
    openClient: vi.fn(),
    submitInput: vi.fn(input?.submitInput ?? (async () => ({ handled: false }))),
    executeCommand: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    closeClient: vi.fn(async (_clientId: string, signal?: AbortSignal) =>
      input?.closeClient?.(signal)),
    openEventStream: vi.fn(async (
      _clientId: string,
      _onEvent: unknown,
      signal: AbortSignal,
    ) => input?.openEventStream?.(signal)),
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

  it("dispose 不会被 closeClient 的挂起请求卡住", async () => {
    const transport = createTransportStub({
      closeClient: async (signal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    const controller = new TestBackendClientController(transport);

    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(transport.closeClient).toHaveBeenCalledWith("client_test", expect.any(AbortSignal));
  });

  it("requestExit 会立即中止事件流并停止 heartbeat", async () => {
    vi.useFakeTimers();
    let eventStreamSignal: AbortSignal | undefined;
    const transport = createTransportStub({
      openEventStream: async (signal) => {
        eventStreamSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    const controller = new TestBackendClientController(transport, {
      ...createEmptyState("/tmp/project"),
      activeExecutorId: "executor_test",
    });

    try {
      await controller.startEventStreamForTest();
      controller.startHeartbeatForTest();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(transport.heartbeatExecutor).toHaveBeenCalledTimes(1);

      await controller.requestExit();
      expect(eventStreamSignal?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(transport.heartbeatExecutor).toHaveBeenCalledTimes(1);
    } finally {
      await controller.dispose();
      vi.useRealTimers();
    }
  });

  it("waitForExit 会在 requestExit 后完成", async () => {
    const transport = createTransportStub();
    const controller = new TestBackendClientController(transport);

    try {
      const waiting = controller.waitForExit().then(() => "resolved");
      await controller.requestExit();
      await expect(Promise.race([
        waiting,
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ])).resolves.toBe("resolved");
    } finally {
      await controller.dispose();
    }
  });
});
