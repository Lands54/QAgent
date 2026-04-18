import { describe, expect, it, vi } from "vitest";

import { RuntimeInputQueue } from "../../src/runtime/application/runtimeInputQueue.js";

describe("RuntimeInputQueue", () => {
  it("会按 FIFO 顺序执行排队输入", async () => {
    const calls: string[] = [];
    const queue = new RuntimeInputQueue({
      isDisposed: () => false,
      hasPendingApproval: () => false,
      isRunning: () => false,
      onStateChanged: vi.fn(),
      executeQueuedInput: vi.fn(async (task) => {
        calls.push(task.input);
      }),
    });

    await Promise.all([
      queue.submitInput("first"),
      queue.submitInput("second"),
    ]);

    expect(calls).toEqual(["first", "second"]);
  });

  it("待审批期间不会消费队列，恢复后可继续 drain", async () => {
    const calls: string[] = [];
    let pendingApproval = true;
    const queue = new RuntimeInputQueue({
      isDisposed: () => false,
      hasPendingApproval: () => pendingApproval,
      isRunning: () => false,
      onStateChanged: vi.fn(),
      executeQueuedInput: vi.fn(async (task) => {
        calls.push(task.input);
      }),
    });

    const pending = queue.submitInput("blocked");
    await Promise.resolve();
    expect(calls).toEqual([]);

    pendingApproval = false;
    queue.scheduleDrain();
    await pending;

    expect(calls).toEqual(["blocked"]);
  });
});
