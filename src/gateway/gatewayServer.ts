import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { GatewayEdgeBridgeClient } from "./edgeBridgeClient.js";
import { GatewayHost } from "./gatewayHost.js";
import {
  commandRequestLogFields,
  gatewayErrorFields,
  type GatewayLogger,
  type GatewayLogFields,
} from "./gatewayLogger.js";
import { clearGatewayManifest, writeGatewayManifest } from "./manifest.js";
import type {
  GatewayCommandEnvelope,
  GatewayHealthResponse,
  GatewaySseEvent,
} from "./types.js";
import type { CliOptions } from "../types.js";
import {
  createId,
  getBuildInfo,
  HttpJsonBodyError,
  readJsonBody,
} from "../utils/index.js";

interface SseClient {
  clientId?: string;
  scope: "client" | "workspace";
  response: ServerResponse;
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

function isExecutorHeartbeatPath(pathname: string): boolean {
  return /^\/api\/executors\/[^/]+\/heartbeat$/u.test(pathname);
}

function shouldSkipHttpLog(method: string, pathname: string, statusCode: number): boolean {
  if (statusCode >= 400) {
    return false;
  }
  return (
    (method === "GET" && pathname === "/api/health")
    || (method === "POST" && isExecutorHeartbeatPath(pathname))
  );
}

export class GatewayServer {
  public static async create(cliOptions: CliOptions): Promise<GatewayServer> {
    const host = await GatewayHost.create(cliOptions);
    return new GatewayServer(host);
  }

  private readonly server = createServer((request, response) => {
    void this.handleRequest(request, response);
  });
  private readonly sseClients = new Set<SseClient>();
  private stopResolver?: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.stopResolver = resolve;
  });
  private edgeBridge?: GatewayEdgeBridgeClient;
  private readonly heartbeatSweepTimer: NodeJS.Timeout;
  private readonly logger: GatewayLogger;
  private stopping = false;

  private constructor(private readonly host: GatewayHost) {
    this.logger = host.getLogger();
    this.heartbeatSweepTimer = setInterval(() => {
      this.host.sweepExpiredLeases(20_000);
    }, 5_000);
    this.heartbeatSweepTimer.unref?.();
    this.host.subscribe((event) => {
      for (const client of this.sseClients) {
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
    });
  }

  public async listen(): Promise<{
    port: number;
    baseUrl: string;
    logPath: string;
  }> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("gateway 未能获取监听端口。");
    }
    const port = address.port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const buildInfo = getBuildInfo();
    const workspaceId = this.host.getConfig().gateway.workspaceId ?? "local";
    const logPath = this.logger.getLogPath();
    await writeGatewayManifest(this.host.getConfig().resolvedPaths.sessionRoot, {
      pid: process.pid,
      port,
      baseUrl,
      cwd: this.host.getConfig().cwd,
      sessionRoot: this.host.getConfig().resolvedPaths.sessionRoot,
      workspaceId,
      logPath,
      version: buildInfo.version,
      buildSha: buildInfo.buildSha,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.logger.info("gateway.listen", {
      baseUrl,
      cwd: this.host.getConfig().cwd,
      logPath,
      port,
      sessionRoot: this.host.getConfig().resolvedPaths.sessionRoot,
      workspaceId,
    });
    const gatewayConfig = this.host.getConfig().gateway;
    const hasRemoteConfig = Boolean(
      gatewayConfig.workspaceId
      || gatewayConfig.edgeBaseUrl
      || gatewayConfig.apiToken,
    );
    if (hasRemoteConfig) {
      if (
        !gatewayConfig.workspaceId
        || !gatewayConfig.edgeBaseUrl
        || !gatewayConfig.apiToken
      ) {
        throw new Error("gateway 远程注册配置不完整，需要 workspaceId、edgeBaseUrl、apiToken。");
      }
      try {
        this.logger.info("edge_bridge.starting", {
          edgeBaseUrl: gatewayConfig.edgeBaseUrl,
          workspaceId: gatewayConfig.workspaceId,
        });
        this.edgeBridge = new GatewayEdgeBridgeClient({
          host: this.host,
          edgeBaseUrl: gatewayConfig.edgeBaseUrl,
          workspaceId: gatewayConfig.workspaceId,
          apiToken: gatewayConfig.apiToken,
          localBaseUrl: baseUrl,
          requestStop: (reason) => {
            void this.stop(reason).catch((error) => {
              this.logger.error("gateway.stop.requested.error", {
                reason,
                ...gatewayErrorFields(error),
              });
            });
          },
        });
        await this.edgeBridge.start();
        this.logger.info("edge_bridge.started", {
          workspaceId: gatewayConfig.workspaceId,
        });
      } catch (error) {
        this.logger.error("edge_bridge.start.error", {
          workspaceId: gatewayConfig.workspaceId,
          ...gatewayErrorFields(error),
        });
        throw error;
      }
    }
    return {
      port,
      baseUrl,
      logPath,
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
    this.logger.info("gateway.stop.started", {
      reason,
      sseClientCount: this.sseClients.size,
    });
    try {
      try {
        await this.edgeBridge?.notifyStopping(reason);
      } catch (error) {
        this.logger.error("edge_bridge.notify_stopping.error", {
          reason,
          ...gatewayErrorFields(error),
        });
      }
      try {
        await this.edgeBridge?.dispose();
      } catch (error) {
        this.logger.error("edge_bridge.dispose.error", {
          reason,
          ...gatewayErrorFields(error),
        });
      }
      this.edgeBridge = undefined;
      for (const client of this.sseClients) {
        writeSse(client.response, {
          id: createId("gw"),
          type: "gateway.stopping",
          createdAt: new Date().toISOString(),
          payload: { reason },
        });
        client.response.end();
      }
      this.sseClients.clear();
      clearInterval(this.heartbeatSweepTimer);
      await this.host.dispose();
      await clearGatewayManifest(this.host.getConfig().resolvedPaths.sessionRoot);
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.logger.info("gateway.stop.completed", { reason });
    } catch (error) {
      this.logger.error("gateway.stop.error", {
        reason,
        ...gatewayErrorFields(error),
      });
      throw error;
    } finally {
      this.stopResolver?.();
      await this.logger.flush();
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "UNKNOWN";
    const startedAt = Date.now();
    const requestLogFields: GatewayLogFields = {
      method,
      path: url.pathname,
    };
    let suppressHttpLog = false;
    response.on("finish", () => {
      if (suppressHttpLog || shouldSkipHttpLog(method, url.pathname, response.statusCode)) {
        return;
      }
      this.logger.info("http.request", {
        ...requestLogFields,
        durationMs: Date.now() - startedAt,
        statusCode: response.statusCode,
      });
    });
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        const buildInfo = getBuildInfo();
        const payload: GatewayHealthResponse = {
          ok: true,
          pid: process.pid,
          cwd: this.host.getConfig().cwd,
          sessionRoot: this.host.getConfig().resolvedPaths.sessionRoot,
          workspaceId: this.host.getConfig().gateway.workspaceId ?? "local",
          logPath: this.logger.getLogPath(),
          clientCount: this.host.getClientCount(),
          leaseCount: this.host.getLeaseCount(),
          version: buildInfo.version,
          buildSha: buildInfo.buildSha,
        };
        json(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/clients/open") {
        const body = await readJsonBody(request) as {
          clientId?: string;
          clientLabel: "cli" | "tui" | "api";
        };
        Object.assign(requestLogFields, {
          clientId: body.clientId,
          clientLabel: body.clientLabel,
        });
        const opened = await this.host.openClient(body);
        Object.assign(requestLogFields, {
          clientId: opened.clientId,
        });
        json(response, 200, opened);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        const clientId = url.searchParams.get("clientId");
        Object.assign(requestLogFields, { clientId });
        if (!clientId) {
          json(response, 400, { error: "缺少 clientId。" });
          return;
        }
        json(response, 200, await this.host.getState(clientId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        suppressHttpLog = true;
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
          clientId,
          scope,
          response,
        };
        const sseStartedAt = Date.now();
        this.sseClients.add(client);
        this.logger.info("sse.connect", {
          activeSseClients: this.sseClients.size,
          clientId,
          scope,
        });
        request.on("close", () => {
          this.sseClients.delete(client);
          this.logger.info("sse.disconnect", {
            activeSseClients: this.sseClients.size,
            clientId,
            durationMs: Date.now() - sseStartedAt,
            scope,
          });
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/input") {
        const body = await readJsonBody(request) as {
          clientId: string;
          input: string;
        };
        Object.assign(requestLogFields, {
          clientId: body.clientId,
          inputLength: body.input.trim().length,
        });
        const result = await this.host.submitInput(body.clientId, body.input);
        Object.assign(requestLogFields, {
          exitRequested: result.exitRequested,
          handled: result.handled,
        });
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/commands") {
        const body = await readJsonBody(request) as GatewayCommandEnvelope;
        Object.assign(requestLogFields, {
          clientId: body.clientId,
          commandId: body.commandId,
          executorId: body.executorId,
          ...commandRequestLogFields(body.request),
        });
        const result = await this.host.executeCommand(body);
        Object.assign(requestLogFields, {
          commandResultCode: result.result.code,
          commandStatus: result.result.status,
        });
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/executors/open") {
        const body = await readJsonBody(request) as {
          clientId: string;
          worklineId?: string;
        };
        Object.assign(requestLogFields, {
          clientId: body.clientId,
          worklineId: body.worklineId,
        });
        const result = this.host.openExecutor(body.clientId, body.worklineId);
        Object.assign(requestLogFields, {
          executorId: result.executorId,
          worklineId: result.worklineId,
        });
        json(response, 200, result);
        return;
      }

      if (
        request.method === "POST"
        && url.pathname.startsWith("/api/executors/")
        && url.pathname.endsWith("/heartbeat")
      ) {
        const executorId = url.pathname.split("/")[3];
        if (!executorId) {
          json(response, 400, { error: "缺少 executorId。" });
          return;
        }
        const body = await readJsonBody(request) as { clientId: string };
        Object.assign(requestLogFields, {
          clientId: body.clientId,
          executorId,
        });
        this.host.heartbeatExecutor(executorId, body.clientId);
        json(response, 200, { ok: true });
        return;
      }

      if (
        request.method === "DELETE"
        && url.pathname.startsWith("/api/executors/")
      ) {
        const executorId = url.pathname.split("/")[3];
        if (!executorId) {
          json(response, 400, { error: "缺少 executorId。" });
          return;
        }
        Object.assign(requestLogFields, {
          clientId: url.searchParams.get("clientId") ?? undefined,
          executorId,
        });
        this.host.releaseExecutor(executorId, url.searchParams.get("clientId") ?? undefined);
        json(response, 200, { ok: true });
        return;
      }

      if (
        request.method === "DELETE"
        && url.pathname.startsWith("/api/clients/")
      ) {
        const clientId = url.pathname.split("/")[3];
        if (!clientId) {
          json(response, 400, { error: "缺少 clientId。" });
          return;
        }
        Object.assign(requestLogFields, { clientId });
        this.host.closeClient(clientId);
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/stop") {
        this.logger.info("admin.stop", { reason: "admin-stop" });
        json(response, 200, { ok: true });
        void this.stop("admin-stop").catch((error) => {
          this.logger.error("gateway.stop.admin.error", {
            reason: "admin-stop",
            ...gatewayErrorFields(error),
          });
        });
        return;
      }

      json(response, 404, { error: "未找到接口。" });
    } catch (error) {
      Object.assign(requestLogFields, gatewayErrorFields(error));
      const statusCode = error instanceof HttpJsonBodyError
        ? error.statusCode
        : 500;
      json(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
