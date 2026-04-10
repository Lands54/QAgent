import type { AppState } from "../runtime/index.js";
import type {
  CliOptions,
  CommandRequest,
  CommandResult,
  RuntimeEvent,
} from "../types.js";

export interface GatewayManifest {
  pid: number;
  port: number;
  baseUrl: string;
  cwd: string;
  sessionRoot: string;
  workspaceId: string;
  logPath?: string;
  version: string;
  buildSha: string;
  startedAt: string;
  updatedAt: string;
}

export interface GatewayClientSession {
  clientId: string;
  clientLabel: "cli" | "tui" | "api";
  activeWorklineId?: string;
  activeExecutorId?: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface GatewayExecutorLease {
  executorId: string;
  worklineId: string;
  clientId: string;
  attachedAt: string;
  lastHeartbeatAt: string;
  detachedAt?: string;
}

export interface GatewayCommandEnvelope {
  commandId: string;
  clientId: string;
  executorId?: string;
  request: CommandRequest;
}

export interface GatewayCommandResult {
  commandId: string;
  result: CommandResult;
}

export interface GatewayOpenClientRequest {
  clientId?: string;
  clientLabel: GatewayClientSession["clientLabel"];
}

export interface GatewayOpenClientResponse {
  clientId: string;
  state: AppState;
}

export interface GatewayStateResponse {
  state: AppState;
}

export interface GatewayHealthResponse {
  ok: true;
  pid: number;
  cwd: string;
  sessionRoot: string;
  workspaceId: string;
  logPath?: string;
  clientCount: number;
  leaseCount: number;
  version: string;
  buildSha: string;
}

export type GatewaySseEvent =
  | {
      id: string;
      type: "state.snapshot";
      createdAt: string;
      clientId: string;
      payload: {
        state: AppState;
      };
    }
  | {
      id: string;
      type: "runtime.event";
      createdAt: string;
      clientId?: string;
      commandId?: string;
      payload: {
        event: RuntimeEvent;
      };
    }
  | {
      id: string;
      type: "gateway.stopping";
      createdAt: string;
      payload: {
        reason: string;
      };
    }
  | {
      id: string;
      type: "gateway.disconnected";
      createdAt: string;
      payload: {
        reason: string;
        workspaceId?: string;
      };
    };

export interface GatewayConnectionInput {
  cliOptions: CliOptions;
  clientLabel: GatewayClientSession["clientLabel"];
}
