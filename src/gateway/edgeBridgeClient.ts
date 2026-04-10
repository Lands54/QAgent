import { WebSocket, type RawData } from "ws";

import type {
  EdgeGatewayRpcRequest,
  EdgeGatewayRpcResult,
  EdgeGatewaySocketMessage,
  GatewayEventEnvelope,
  GatewayHealthEnvelope,
  GatewayRegisterMessage,
} from "../types.js";
import type { GatewayHost } from "./gatewayHost.js";
import type { GatewaySseEvent } from "./types.js";
import { createId, getBuildInfo } from "../utils/index.js";

function toWebSocketUrl(baseUrl: string): string {
  if (baseUrl.startsWith("https://")) {
    return `wss://${baseUrl.slice("https://".length)}`;
  }
  if (baseUrl.startsWith("http://")) {
    return `ws://${baseUrl.slice("http://".length)}`;
  }
  return baseUrl;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface GatewayEdgeBridgeInput {
  host: GatewayHost;
  edgeBaseUrl: string;
  workspaceId: string;
  apiToken: string;
  localBaseUrl: string;
  requestStop: (reason: string) => void;
}

type GatewayRpcSuccessPayload = Extract<EdgeGatewayRpcResult, { ok: true }>["payload"];

export class GatewayEdgeBridgeClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private disposed = false;
  private readonly unsubscribe: () => void;

  public constructor(private readonly input: GatewayEdgeBridgeInput) {
    this.unsubscribe = this.input.host.subscribe((event) => {
      void this.sendEvent(event).catch(() => {
        this.closeCurrentSocket(1011, "gateway bridge event send failed");
      });
    });
  }

  public async start(): Promise<void> {
    this.connect();
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.socket?.close();
  }

  public async notifyStopping(reason: string): Promise<void> {
    await this.sendEvent({
      id: createId("gw"),
      type: "gateway.stopping",
      createdAt: nowIso(),
      payload: {
        reason,
      },
    });
  }

  private connect(): void {
    const wsUrl = `${toWebSocketUrl(this.input.edgeBaseUrl)}/internal/gateways/connect`;
    const socket = new WebSocket(wsUrl, {
      headers: {
        authorization: `Bearer ${this.input.apiToken}`,
      },
    });
    this.socket = socket;

    socket.on("open", () => {
      try {
        this.sendRegister();
        this.startHeartbeat();
      } catch {
        socket.close(1011, "gateway bridge register failed");
      }
    });
    socket.on("message", (raw: RawData) => {
      void this.handleMessage(raw.toString()).catch(() => {
        socket.close(1003, "invalid edge message");
      });
    });
    socket.on("close", () => {
      this.handleDisconnect();
    });
    socket.on("error", () => {
      this.handleDisconnect();
    });
  }

  private handleDisconnect(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.socket = undefined;
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.disposed) {
        this.connect();
      }
    }, 3_000);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      void this.sendHealth().catch(() => {
        this.closeCurrentSocket(1011, "gateway bridge health send failed");
      });
    }, 5_000);
    this.heartbeatTimer.unref?.();
  }

  private closeCurrentSocket(code: number, reason: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close(code, reason);
    }
  }

  private getBuildHealthSummary() {
    return {
      clientCount: this.input.host.getClientCount(),
      leaseCount: this.input.host.getLeaseCount(),
      localBaseUrl: this.input.localBaseUrl,
      lastUpdatedAt: nowIso(),
    };
  }

  private sendRegister(): void {
    const buildInfo = getBuildInfo();
    const message: GatewayRegisterMessage = {
      type: "gateway.register",
      requestId: createId("register"),
      payload: {
        workspaceId: this.input.workspaceId,
        sessionRoot: this.input.host.getConfig().resolvedPaths.sessionRoot,
        pid: process.pid,
        version: buildInfo.version,
        buildSha: buildInfo.buildSha,
        capabilities: [
          "openClient",
          "closeClient",
          "getState",
          "submitInput",
          "executeCommand",
          "openExecutor",
          "heartbeatExecutor",
          "releaseExecutor",
          "stopGateway",
        ],
        health: this.getBuildHealthSummary(),
      },
    };
    this.sendMessage(message);
  }

  private async sendHealth(): Promise<void> {
    const message: GatewayHealthEnvelope = {
      type: "gateway.health",
      workspaceId: this.input.workspaceId,
      payload: this.getBuildHealthSummary(),
    };
    this.sendMessage(message);
  }

  private async sendEvent(event: GatewaySseEvent): Promise<void> {
    const message: GatewayEventEnvelope = {
      type: "gateway.event",
      workspaceId: this.input.workspaceId,
      event,
    };
    this.sendMessage(message);
  }

  private sendMessage(message: EdgeGatewaySocketMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = JSON.parse(raw) as EdgeGatewaySocketMessage;
    if (message.type !== "gateway.rpc.request") {
      return;
    }
    await this.handleRpcRequest(message);
  }

  private async handleRpcRequest(message: EdgeGatewayRpcRequest): Promise<void> {
    try {
      const payload = await this.executeAction(message.action);
      const result: EdgeGatewayRpcResult = {
        type: "gateway.rpc.result",
        requestId: message.requestId,
        workspaceId: this.input.workspaceId,
        ok: true,
        payload,
      };
      this.sendMessage(result);
    } catch (error) {
      const result: EdgeGatewayRpcResult = {
        type: "gateway.rpc.result",
        requestId: message.requestId,
        workspaceId: this.input.workspaceId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.sendMessage(result);
    }
  }

  private async executeAction(
    action: EdgeGatewayRpcRequest["action"],
  ): Promise<GatewayRpcSuccessPayload> {
    switch (action.kind) {
      case "openClient":
        return this.input.host.openClient(action.payload);
      case "closeClient":
        this.input.host.closeClient(action.payload.clientId);
        return { ok: true };
      case "getState":
        return this.input.host.getState(action.payload.clientId);
      case "submitInput":
        return this.input.host.submitInput(action.payload.clientId, action.payload.input);
      case "executeCommand":
        return this.input.host.executeCommand(action.payload);
      case "openExecutor":
        return this.input.host.openExecutor(
          action.payload.clientId,
          action.payload.worklineId,
        );
      case "heartbeatExecutor":
        this.input.host.heartbeatExecutor(
          action.payload.executorId,
          action.payload.clientId,
        );
        return { ok: true };
      case "releaseExecutor":
        this.input.host.releaseExecutor(
          action.payload.executorId,
          action.payload.clientId,
        );
        return { ok: true };
      case "stopGateway":
        setTimeout(() => {
          this.input.requestStop(action.payload.reason ?? "edge-stop");
        }, 0).unref?.();
        return { ok: true };
    }
  }
}
