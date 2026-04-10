import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { clearEdgeManifest, readEdgeManifest, writeEdgeManifest } from "./manifest.js";
import { loadRuntimeConfig } from "../config/index.js";
import type {
  GatewayCommandEnvelope,
  GatewayOpenClientResponse,
  GatewayOpenClientRequest,
  GatewaySseEvent,
} from "../gateway/index.js";
import type {
  CliOptions,
  EdgeGatewayRpcAction,
  EdgeGatewayRpcRequest,
  EdgeGatewayRpcResult,
  EdgeGatewaySocketMessage,
  EdgeHealthResponse,
  EdgeManifest,
  GatewayConnectionState,
  GatewayRegisteredMessage,
  RemoteClientSession,
  RuntimeConfig,
  WorkspaceRegistration,
} from "../types.js";
import {
  createId,
  getBuildInfo,
  HttpJsonBodyError,
  readJsonBody,
} from "../utils/index.js";

interface SseClient {
  workspaceId: string;
  clientId?: string;
  scope: "client" | "workspace";
  response: ServerResponse;
}

interface PendingRpc {
  resolve: (message: EdgeGatewayRpcResult) => void;
  reject: (error: Error) => void;
}

interface ConnectedWorkspace {
  socket: WebSocket;
  registration: WorkspaceRegistration;
  pendingRpcs: Map<string, PendingRpc>;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function writeSse(response: ServerResponse, event: GatewaySseEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseBearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) {
    return undefined;
  }
  const [scheme, token] = headerValue.split(/\s+/u);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return undefined;
  }
  return token;
}

function workspaceClientKey(workspaceId: string, clientId: string): string {
  return `${workspaceId}:${clientId}`;
}

export class EdgeServer {
  public static async create(cliOptions: CliOptions): Promise<EdgeServer> {
    const config = await loadRuntimeConfig(cliOptions);
    if (!config.gateway.apiToken) {
      throw new Error("启动 edge 需要配置 apiToken。");
    }
    return new EdgeServer(config);
  }

  private readonly server = createServer((request, response) => {
    void this.handleRequest(request, response);
  });
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly sseClients = new Set<SseClient>();
  private readonly workspaces = new Map<string, ConnectedWorkspace>();
  private readonly remoteClients = new Map<string, RemoteClientSession>();
  private stopResolver?: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.stopResolver = resolve;
  });
  private baseUrl?: string;
  private stopping = false;

  private constructor(private readonly config: RuntimeConfig) {
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    this.wsServer.on("connection", (socket) => {
      this.handleGatewaySocket(socket);
    });
  }

  public async listen(): Promise<{
    port: number;
    baseUrl: string;
  }> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.config.edge.port, this.config.edge.bindHost, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("edge 未能获取监听端口。");
    }
    const port = address.port;
    const host = this.config.edge.bindHost;
    this.baseUrl = `http://${host}:${port}`;
    const buildInfo = getBuildInfo();
    await writeEdgeManifest(this.config.resolvedPaths.globalAgentDir, {
      pid: process.pid,
      port,
      baseUrl: this.baseUrl,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      version: buildInfo.version,
      buildSha: buildInfo.buildSha,
    });
    return {
      port,
      baseUrl: this.baseUrl,
    };
  }

  public async waitUntilStopped(): Promise<void> {
    await this.stopped;
  }

  public async stop(reason = "manual-stop"): Promise<void> {
    if (this.stopping) {
      await this.stopped;
      return;
    }
    this.stopping = true;
    try {
      const stopEvent: GatewaySseEvent = {
        id: createId("edge"),
        type: "gateway.stopping",
        createdAt: nowIso(),
        payload: {
          reason,
        },
      };
      for (const client of this.sseClients) {
        writeSse(client.response, stopEvent);
        client.response.end();
      }
      this.sseClients.clear();

      for (const workspace of this.workspaces.values()) {
        for (const pending of workspace.pendingRpcs.values()) {
          pending.reject(new Error("edge 正在停止。"));
        }
        workspace.pendingRpcs.clear();
        workspace.socket.close();
      }
      this.workspaces.clear();
      this.remoteClients.clear();

      await clearEdgeManifest(this.config.resolvedPaths.globalAgentDir);
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } finally {
      this.stopResolver?.();
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/internal/gateways/connect") {
      socket.destroy();
      return;
    }
    if (!this.isAuthorized(request.headers.authorization)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wsServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      this.wsServer.emit("connection", ws, request);
    });
  }

  private handleGatewaySocket(socket: WebSocket): void {
    socket.on("message", (data: RawData) => {
      void this.handleGatewayMessage(socket, data.toString()).catch(() => {
        socket.close(1003, "invalid gateway message");
      });
    });
    socket.on("close", () => {
      this.handleGatewayDisconnect(socket, "gateway disconnected");
    });
    socket.on("error", () => {
      this.handleGatewayDisconnect(socket, "gateway socket error");
    });
  }

  private async handleGatewayMessage(socket: WebSocket, raw: string): Promise<void> {
    const message = JSON.parse(raw) as EdgeGatewaySocketMessage;
    if (message.type === "gateway.register") {
      const existing = this.workspaces.get(message.payload.workspaceId);
      if (existing && existing.socket !== socket) {
        socket.send(JSON.stringify({
          type: "gateway.rpc.result",
          requestId: message.requestId,
          workspaceId: message.payload.workspaceId,
          ok: false,
          error: `workspace ${message.payload.workspaceId} 已有活动 gateway。`,
        } satisfies EdgeGatewayRpcResult));
        socket.close(4009, "workspace busy");
        return;
      }
      const connectedAt = nowIso();
      this.workspaces.set(message.payload.workspaceId, {
        socket,
        registration: {
          workspaceId: message.payload.workspaceId,
          sessionRoot: message.payload.sessionRoot,
          pid: message.payload.pid,
          version: message.payload.version,
          buildSha: message.payload.buildSha,
          capabilities: message.payload.capabilities,
          connectedAt,
          lastSeenAt: connectedAt,
          health: message.payload.health,
        },
        pendingRpcs: existing?.pendingRpcs ?? new Map<string, PendingRpc>(),
      });
      const registered: GatewayRegisteredMessage = {
        type: "gateway.registered",
        requestId: message.requestId,
        payload: {
          workspaceId: message.payload.workspaceId,
          connectedAt,
        },
      };
      socket.send(JSON.stringify(registered));
      return;
    }

    if (message.type === "gateway.rpc.result") {
      const workspace = this.workspaces.get(message.workspaceId);
      const pending = workspace?.pendingRpcs.get(message.requestId);
      if (!pending) {
        return;
      }
      workspace?.pendingRpcs.delete(message.requestId);
      pending.resolve(message);
      return;
    }

    if (message.type === "gateway.event") {
      const workspace = this.workspaces.get(message.workspaceId);
      if (workspace) {
        workspace.registration.lastSeenAt = nowIso();
      }
      this.emitWorkspaceEvent(message.workspaceId, message.event as GatewaySseEvent);
      return;
    }

    if (message.type === "gateway.health") {
      const workspace = this.workspaces.get(message.workspaceId);
      if (!workspace) {
        return;
      }
      workspace.registration.health = message.payload;
      workspace.registration.lastSeenAt = nowIso();
    }
  }

  private handleGatewayDisconnect(socket: WebSocket, reason: string): void {
    const entry = [...this.workspaces.entries()].find(([, workspace]) => workspace.socket === socket);
    if (!entry) {
      return;
    }
    const [workspaceId, workspace] = entry;
    for (const pending of workspace.pendingRpcs.values()) {
      pending.reject(new Error(`workspace ${workspaceId} 已离线。`));
    }
    workspace.pendingRpcs.clear();
    this.workspaces.delete(workspaceId);
    this.emitWorkspaceEvent(workspaceId, {
      id: createId("edge"),
      type: "gateway.disconnected",
      createdAt: nowIso(),
      payload: {
        reason,
        workspaceId,
      },
    });
  }

  private emitWorkspaceEvent(workspaceId: string, event: GatewaySseEvent): void {
    for (const client of this.sseClients) {
      if (client.workspaceId !== workspaceId) {
        continue;
      }
      if (client.scope === "workspace") {
        writeSse(client.response, event);
        continue;
      }
      if (
        event.type === "gateway.stopping"
        || event.type === "gateway.disconnected"
        || ("clientId" in event && client.clientId === event.clientId)
      ) {
        writeSse(client.response, event);
      }
    }
  }

  private isAuthorized(headerValue: string | undefined): boolean {
    const token = parseBearerToken(headerValue);
    return Boolean(token && token === this.config.gateway.apiToken);
  }

  private requireAuthorized(request: IncomingMessage, response: ServerResponse): boolean {
    if (this.isAuthorized(request.headers.authorization)) {
      return true;
    }
    json(response, 401, { error: "未授权。" });
    return false;
  }

  private getWorkspaceState(workspaceId: string): GatewayConnectionState {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return {
        workspaceId,
        online: false,
      };
    }
    return {
      workspaceId,
      online: true,
      sessionRoot: workspace.registration.sessionRoot,
      pid: workspace.registration.pid,
      version: workspace.registration.version,
      buildSha: workspace.registration.buildSha,
      connectedAt: workspace.registration.connectedAt,
      lastSeenAt: workspace.registration.lastSeenAt,
      health: workspace.registration.health,
    };
  }

  private async sendRpc(
    workspaceId: string,
    action: EdgeGatewayRpcAction,
  ): Promise<Extract<EdgeGatewayRpcResult, { ok: true }>> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`workspace ${workspaceId} 当前离线。`);
    }
    const requestId = createId("rpc");
    const message: EdgeGatewayRpcRequest = {
      type: "gateway.rpc.request",
      requestId,
      workspaceId,
      action,
    };
    const result = await new Promise<EdgeGatewayRpcResult>((resolve, reject) => {
      workspace.pendingRpcs.set(requestId, { resolve, reject });
      workspace.socket.send(JSON.stringify(message), (error?: Error) => {
        if (!error) {
          return;
        }
        workspace.pendingRpcs.delete(requestId);
        reject(error);
      });
      setTimeout(() => {
        if (!workspace.pendingRpcs.has(requestId)) {
          return;
        }
        workspace.pendingRpcs.delete(requestId);
        reject(new Error(`workspace ${workspaceId} RPC 超时。`));
      }, 15_000).unref?.();
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        const buildInfo = getBuildInfo();
        const payload: EdgeHealthResponse = {
          ok: true,
          pid: process.pid,
          baseUrl: this.baseUrl ?? "",
          workspaceCount: this.workspaces.size,
          version: buildInfo.version,
          buildSha: buildInfo.buildSha,
        };
        json(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/stop") {
        json(response, 200, { ok: true });
        void this.stop("admin-stop").catch((error) => {
          process.stderr.write(
            `edge stop failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
        return;
      }

      if (!url.pathname.startsWith("/v1/")) {
        json(response, 404, { error: "未找到接口。" });
        return;
      }

      if (!this.requireAuthorized(request, response)) {
        return;
      }

      const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)(\/.*)?$/u);
      if (!match?.[1]) {
        json(response, 404, { error: "未找到 workspace。" });
        return;
      }
      const workspaceId = decodeURIComponent(match[1]);
      const suffix = match[2] ?? "";

      if (request.method === "GET" && suffix === "/health") {
        json(response, 200, this.getWorkspaceState(workspaceId));
        return;
      }

      if (request.method === "POST" && suffix === "/clients/open") {
        const body = await readJsonBody(request) as GatewayOpenClientRequest;
        const result = await this.sendRpc(workspaceId, {
          kind: "openClient",
          payload: body,
        });
        const payload = result.payload as GatewayOpenClientResponse;
        if (payload.clientId) {
          this.remoteClients.set(workspaceClientKey(workspaceId, payload.clientId), {
            clientId: payload.clientId,
            workspaceId,
            clientLabel: body.clientLabel,
            createdAt: nowIso(),
            lastSeenAt: nowIso(),
          });
        }
        json(response, 200, payload);
        return;
      }

      if (request.method === "GET" && suffix === "/state") {
        const clientId = url.searchParams.get("clientId");
        if (!clientId) {
          json(response, 400, { error: "缺少 clientId。" });
          return;
        }
        const result = await this.sendRpc(workspaceId, {
          kind: "getState",
          payload: { clientId },
        });
        json(response, 200, result.payload);
        return;
      }

      if (request.method === "GET" && suffix === "/events") {
        const clientId = url.searchParams.get("clientId") ?? undefined;
        const scope =
          url.searchParams.get("scope") === "workspace" ? "workspace" : "client";
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write(": connected\n\n");
        const client: SseClient = {
          workspaceId,
          clientId,
          scope,
          response,
        };
        this.sseClients.add(client);
        request.on("close", () => {
          this.sseClients.delete(client);
        });
        return;
      }

      if (request.method === "POST" && suffix === "/input") {
        const body = await readJsonBody(request) as {
          clientId: string;
          input: string;
        };
        const result = await this.sendRpc(workspaceId, {
          kind: "submitInput",
          payload: body,
        });
        json(response, 200, result.payload);
        return;
      }

      if (request.method === "POST" && suffix === "/commands") {
        const body = await readJsonBody(request) as GatewayCommandEnvelope;
        const result = await this.sendRpc(workspaceId, {
          kind: "executeCommand",
          payload: body,
        });
        json(response, 200, result.payload);
        return;
      }

      if (request.method === "POST" && suffix === "/executors/open") {
        const body = await readJsonBody(request) as {
          clientId: string;
          worklineId?: string;
        };
        const result = await this.sendRpc(workspaceId, {
          kind: "openExecutor",
          payload: body,
        });
        json(response, 200, result.payload);
        return;
      }

      if (
        request.method === "POST"
        && suffix.startsWith("/executors/")
        && suffix.endsWith("/heartbeat")
      ) {
        const executorId = suffix.split("/")[2];
        if (!executorId) {
          json(response, 400, { error: "缺少 executorId。" });
          return;
        }
        const body = await readJsonBody(request) as { clientId: string };
        const result = await this.sendRpc(workspaceId, {
          kind: "heartbeatExecutor",
          payload: { executorId, clientId: body.clientId },
        });
        json(response, 200, result.payload);
        return;
      }

      if (
        request.method === "DELETE"
        && suffix.startsWith("/executors/")
      ) {
        const executorId = suffix.split("/")[2];
        if (!executorId) {
          json(response, 400, { error: "缺少 executorId。" });
          return;
        }
        const result = await this.sendRpc(workspaceId, {
          kind: "releaseExecutor",
          payload: {
            executorId,
            clientId: url.searchParams.get("clientId") ?? undefined,
          },
        });
        json(response, 200, result.payload);
        return;
      }

      if (
        request.method === "DELETE"
        && suffix.startsWith("/clients/")
      ) {
        const clientId = suffix.split("/")[2];
        if (!clientId) {
          json(response, 400, { error: "缺少 clientId。" });
          return;
        }
        this.remoteClients.delete(workspaceClientKey(workspaceId, clientId));
        const result = await this.sendRpc(workspaceId, {
          kind: "closeClient",
          payload: { clientId },
        });
        json(response, 200, result.payload);
        return;
      }

      if (request.method === "POST" && suffix === "/admin/stop-gateway") {
        const result = await this.sendRpc(workspaceId, {
          kind: "stopGateway",
          payload: {
            reason: "edge-admin-stop",
          },
        });
        json(response, 200, result.payload);
        return;
      }

      json(response, 404, { error: "未找到接口。" });
    } catch (error) {
      const statusCode = error instanceof HttpJsonBodyError
        ? error.statusCode
        : 500;
      json(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function pingEdge(baseUrl: string): Promise<EdgeHealthResponse | undefined> {
  try {
    return await fetchJson<EdgeHealthResponse>(`${baseUrl}/api/health`);
  } catch {
    return undefined;
  }
}

export async function getEdgeStatus(
  cliOptions: CliOptions,
): Promise<{
  manifest?: EdgeManifest;
  health?: EdgeHealthResponse;
}> {
  const config = await loadRuntimeConfig(cliOptions);
  const manifest = await readEdgeManifest(config.resolvedPaths.globalAgentDir);
  if (!manifest) {
    return {};
  }
  return {
    manifest,
    health: await pingEdge(manifest.baseUrl),
  };
}

export async function stopEdge(cliOptions: CliOptions): Promise<boolean> {
  const status = await getEdgeStatus(cliOptions);
  if (!status.manifest) {
    return false;
  }
  if (!status.health) {
    await clearEdgeManifest((await loadRuntimeConfig(cliOptions)).resolvedPaths.globalAgentDir);
    return false;
  }
  await fetchJson(`${status.manifest.baseUrl}/api/admin/stop`, {
    method: "POST",
  });
  return true;
}

export async function serveEdge(cliOptions: CliOptions): Promise<void> {
  const server = await EdgeServer.create(cliOptions);
  const { baseUrl } = await server.listen();
  process.stdout.write(`edge listening on ${baseUrl}\n`);

  const stop = async (signal: string) => {
    process.stdout.write(`stopping edge (${signal})\n`);
    await server.stop(signal);
  };
  process.once("SIGINT", () => {
    void stop("SIGINT").catch((error) => {
      process.stderr.write(
        `edge stop failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void stop("SIGTERM").catch((error) => {
      process.stderr.write(
        `edge stop failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  });

  await server.waitUntilStopped();
}
