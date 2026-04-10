import { describe, expect, it, vi } from "vitest";

import { GatewayHost } from "../../src/gateway/gatewayHost.js";
import { createEmptyState, type AppState } from "../../src/runtime/index.js";

interface RefreshableGatewayHost {
  refreshAllClientStates(): Promise<void>;
  clientSessions: {
    listClients(): Array<{ clientId: string }>;
  };
  buildState(clientId: string): Promise<AppState>;
  emitStateSnapshot(clientId: string, state: AppState): void;
  logger: {
    error(event: string, fields?: Record<string, unknown>): void;
  };
}

describe("GatewayHost", () => {
  it("refreshAllClientStates 会隔离单个 client 的刷新失败", async () => {
    const goodState = createEmptyState("/tmp/project");
    const loggerError = vi.fn();
    const emitStateSnapshot = vi.fn();
    const host = Object.create(GatewayHost.prototype) as RefreshableGatewayHost;
    Object.assign(host, {
      clientSessions: {
        listClients: () => [
          { clientId: "client_bad" },
          { clientId: "client_good" },
        ],
      },
      buildState: async (clientId: string) => {
        if (clientId === "client_bad") {
          throw new Error("bad client state");
        }
        return goodState;
      },
      emitStateSnapshot,
      logger: {
        error: loggerError,
      },
    } satisfies Omit<RefreshableGatewayHost, "refreshAllClientStates">);

    await expect(host.refreshAllClientStates()).resolves.toBeUndefined();

    expect(emitStateSnapshot).toHaveBeenCalledWith("client_good", goodState);
    expect(loggerError).toHaveBeenCalledWith(
      "state.refresh.client.error",
      expect.objectContaining({
        clientId: "client_bad",
        errorMessage: "bad client state",
      }),
    );
  });
});
