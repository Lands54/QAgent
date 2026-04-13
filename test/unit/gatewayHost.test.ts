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

  it("命令成功后不会因为生命周期事件失败而整体报错", async () => {
    const loggerInfo = vi.fn();
    const loggerError = vi.fn();
    const result = {
      status: "success",
      code: "run.completed",
      exitCode: 0,
      payload: {},
    };
    const host = Object.create(GatewayHost.prototype) as {
      executeCommand(
        envelope: {
          clientId: string;
          commandId: string;
          request: { domain: string };
        },
      ): Promise<{
        commandId: string;
        result: typeof result;
      }>;
      clientSessions: {
        touchClient(clientId: string): void;
        requireClient(clientId: string): { activeExecutorId?: string };
      };
      ensureClientRuntime(clientId: string): { agentId: string };
      commandContextsByExecutor: Map<string, unknown>;
      createCommandService(clientId: string): {
        execute(request: { domain: string }): Promise<typeof result>;
      };
      syncClientContextAfterCommand(
        clientId: string,
        request: { domain: string },
        commandResult: typeof result,
      ): Promise<void>;
      emitCommandLifecycleEvents(
        clientId: string,
        commandId: string,
        request: { domain: string },
        commandResult: typeof result,
      ): Promise<void>;
      logger: {
        info(event: string, fields?: Record<string, unknown>): void;
        error(event: string, fields?: Record<string, unknown>): void;
      };
    };

    Object.assign(host, {
      clientSessions: {
        touchClient: vi.fn(),
        requireClient: () => ({ activeExecutorId: "executor_1" }),
      },
      ensureClientRuntime: () => ({ agentId: "executor_1" }),
      commandContextsByExecutor: new Map(),
      createCommandService: () => ({
        execute: vi.fn(async () => result),
      }),
      syncClientContextAfterCommand: vi.fn(async () => {}),
      emitCommandLifecycleEvents: vi.fn(async () => {
        throw new Error("state broken");
      }),
      logger: {
        info: loggerInfo,
        error: loggerError,
      },
    });

    await expect(host.executeCommand({
      clientId: "client_1",
      commandId: "cmd_1",
      request: { domain: "run" },
    })).resolves.toEqual({
      commandId: "cmd_1",
      result,
    });

    expect(loggerError).toHaveBeenCalledWith(
      "command.lifecycle_events.error",
      expect.objectContaining({
        clientId: "client_1",
        commandId: "cmd_1",
        executorId: "executor_1",
        errorMessage: "state broken",
      }),
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      "command.completed",
      expect.objectContaining({
        clientId: "client_1",
        commandId: "cmd_1",
        executorId: "executor_1",
        code: "run.completed",
        status: "success",
      }),
    );
  });

  it("命令生命周期事件不依赖 buildState 即可发出", async () => {
    const forwardRuntimeEvent = vi.fn();
    const buildState = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const host = Object.create(GatewayHost.prototype) as {
      emitCommandLifecycleEvents(
        clientId: string,
        commandId: string,
        request: { domain: string; action: string },
        result: {
          status: "success";
          code: string;
          payload: {
            ref: {
              label: string;
            };
          };
        },
      ): Promise<void>;
      ensureClientRuntime(clientId: string): {
        agentId: string;
        headId: string;
        sessionId: string;
      };
      buildState(clientId: string): Promise<AppState>;
      buildRuntimeEvent: GatewayHost["buildRuntimeEvent"];
      forwardRuntimeEvent(event: unknown): void;
    };

    Object.assign(host, {
      ensureClientRuntime: () => ({
        agentId: "executor_1",
        headId: "head_1",
        sessionId: "session_1",
      }),
      buildState,
      buildRuntimeEvent: (GatewayHost.prototype as unknown as {
        buildRuntimeEvent: GatewayHost["buildRuntimeEvent"];
      }).buildRuntimeEvent,
      forwardRuntimeEvent,
    });

    await expect(host.emitCommandLifecycleEvents(
      "client_1",
      "cmd_1",
      {
        domain: "bookmark",
        action: "save",
      },
      {
        status: "success",
        code: "bookmark.saved",
        payload: {
          ref: {
            label: "branch=main",
          },
        },
      },
    )).resolves.toBeUndefined();

    expect(buildState).not.toHaveBeenCalled();
    expect(forwardRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(forwardRuntimeEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "session.changed",
        sessionId: "session_1",
        worklineId: "head_1",
        executorId: "executor_1",
        headId: "head_1",
        agentId: "executor_1",
      }),
    );
    expect(forwardRuntimeEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "command.completed",
        sessionId: "session_1",
        worklineId: "head_1",
        executorId: "executor_1",
        headId: "head_1",
        agentId: "executor_1",
      }),
    );
  });

  it("buildState 在书签刷新失败时会降级为空书签并发出 warning", async () => {
    const loggerWarn = vi.fn();
    const forwardRuntimeEvent = vi.fn();
    const appStateAssemblerBuild = vi.fn((input: { bookmarks: AppState["bookmarks"] }) => {
      return {
        ...createEmptyState("/tmp/project"),
        bookmarks: input.bookmarks,
      };
    });
    const host = Object.create(GatewayHost.prototype) as {
      buildState(clientId: string): Promise<AppState>;
      ensureClientRuntime(clientId: string): {
        agentId: string;
        headId: string;
        sessionId: string;
        getViewState(): {
          id: string;
          kind: "interactive";
          name: string;
          queuedInputCount: number;
        };
      };
      agentManager: {
        listAgents(): [];
        listWorklines(): { worklines: [] };
        listExecutors(): { executors: [] };
        listBookmarks(agentId: string): Promise<{ bookmarks: AppState["bookmarks"] }>;
      };
      approvalPolicy: {
        getMode(): "never";
      };
      skillRegistry: {
        getAll(): [];
      };
      appStateAssembler: {
        build(input: unknown): AppState;
      };
      stateByClient: Map<string, AppState>;
      config: {
        cwd: string;
        runtime: {
          autoCompactThresholdTokens: number;
        };
      };
      logger: {
        warn(event: string, fields?: Record<string, unknown>): void;
      };
      forwardRuntimeEvent(event: unknown): void;
      getCachedState(clientId: string): AppState;
      buildRuntimeEvent: GatewayHost["buildRuntimeEvent"];
    };

    Object.assign(host, {
      ensureClientRuntime: () => ({
        agentId: "executor_1",
        headId: "head_1",
        sessionId: "session_1",
        getViewState: () => ({
          id: "executor_1",
          kind: "interactive",
          name: "main",
          queuedInputCount: 0,
        }),
      }),
      agentManager: {
        listAgents: () => [],
        listWorklines: () => ({ worklines: [] }),
        listExecutors: () => ({ executors: [] }),
        listBookmarks: async () => {
          throw new Error("refs broken");
        },
      },
      approvalPolicy: {
        getMode: () => "never",
      },
      skillRegistry: {
        getAll: () => [],
      },
      appStateAssembler: {
        build: appStateAssemblerBuild,
      },
      stateByClient: new Map(),
      config: {
        cwd: "/tmp/project",
        runtime: {
          autoCompactThresholdTokens: 1000,
        },
      },
      logger: {
        warn: loggerWarn,
      },
      forwardRuntimeEvent,
      getCachedState: (GatewayHost.prototype as unknown as {
        getCachedState: GatewayHost["getCachedState"];
      }).getCachedState,
      buildRuntimeEvent: (GatewayHost.prototype as unknown as {
        buildRuntimeEvent: GatewayHost["buildRuntimeEvent"];
      }).buildRuntimeEvent,
    });

    const state = await host.buildState("client_1");

    expect(state.bookmarks).toEqual([]);
    expect(appStateAssemblerBuild).toHaveBeenCalledWith(expect.objectContaining({
      bookmarks: [],
    }));
    expect(loggerWarn).toHaveBeenCalledWith(
      "state.refresh.partial_error",
      expect.objectContaining({
        clientId: "client_1",
        component: "bookmarks",
        errorMessage: "refs broken",
      }),
    );
    expect(forwardRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "runtime.warning",
        payload: expect.objectContaining({
          source: "state.refresh",
        }),
      }),
    );
  });
});
