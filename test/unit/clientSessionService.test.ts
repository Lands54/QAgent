import { describe, expect, it } from "vitest";

import { ClientSessionService } from "../../src/gateway/clientSessionService.js";

describe("ClientSessionService", () => {
  it("releaseExecutor 会同步清理 client 的 active workline context", () => {
    const sessions = new ClientSessionService();
    sessions.openClient({
      clientId: "client_test",
      clientLabel: "cli",
    });
    sessions.attachExecutor({
      clientId: "client_test",
      executorId: "executor_test",
      worklineId: "workline_test",
    });

    sessions.releaseExecutor("executor_test", "client_test");

    const client = sessions.requireClient("client_test");
    expect(client.activeExecutorId).toBeUndefined();
    expect(client.activeWorklineId).toBeUndefined();
    expect(sessions.getLeaseByExecutorId("executor_test")).toBeUndefined();
    expect(sessions.getLeaseByWorklineId("workline_test")).toBeUndefined();
  });
});
