import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createId } from "../utils/index.js";
import { clearGatewayManifest, writeGatewayManifest } from "./manifest.js";
import { GatewayHost } from "./gatewayHost.js";
import type {
  GatewayCommandEnvelope,
  GatewayHealthResponse,
  GatewaySseEvent,
} from "./types.js";

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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeSse(response: ServerResponse, event: GatewaySseEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export class GatewayServer {
  public static async create(cliOptions: import("../types.js").CliOptions): Promise<GatewayServer> {
    const host = await GatewayHost.create(cliOptions);
    return new GatewayServer(host);
  }

  private readonly server = createServer((request, response) => {
    void this.handleRequest(request, response);
  });
  private readonly sseClients = new Set<SseClient>();
  private readonly stopped = new Promise<void>((resolve) => {
    this.stopResolver = resolve;
  });
  private stopResolver?: () => void;
  private readonly heartbeatSweepTimer = setInterval(() => {
    this.host.sweepExpiredLeases(20_000);
  }, 5_000);

  private constructor(private readonly host: GatewayHost) {
    this.host.subscribe((event) => {
      for (const client of this.sseClients) {
        if (client.scope === "workspace") {
          writeSse(client.response, event);
          continue;
        }
        if (event.type === "gateway.stopping" || client.clientId === event.clientId) {
          writeSse(client.response, event);
        }
      }
    });
  }

  public async listen(): Promise<{
    port: number;
    baseUrl: string;
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
    await writeGatewayManifest(this.host.getConfig().resolvedPaths.sessionRoot, {
      pid: process.pid,
      port,
      baseUrl,
      cwd: this.host.getConfig().cwd,
      sessionRoot: this.host.getConfig().resolvedPaths.sessionRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return {
      port,
      baseUrl,
    };
  }

  public async waitUntilStopped(): Promise<void> {
    await this.stopped;
  }

  public async stop(reason = "manual-stop"): Promise<void> {
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
    this.stopResolver?.();
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        const payload: GatewayHealthResponse = {
          ok: true,
          pid: process.pid,
          cwd: this.host.getConfig().cwd,
          sessionRoot: this.host.getConfig().resolvedPaths.sessionRoot,
          clientCount: this.host.getClientCount(),
          leaseCount: this.host.getLeaseCount(),
        };
        json(response, 200, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/clients/open") {
        const body = await readJson(request) as {
          clientId?: string;
          clientLabel: "cli" | "tui" | "api";
        };
        json(response, 200, await this.host.openClient(body));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        const clientId = url.searchParams.get("clientId");
        if (!clientId) {
          json(response, 400, { error: "缺少 clientId。" });
          return;
        }
        json(response, 200, await this.host.getState(clientId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
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
        this.sseClients.add(client);
        request.on("close", () => {
          this.sseClients.delete(client);
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/input") {
        const body = await readJson(request) as {
          clientId: string;
          input: string;
        };
        json(response, 200, await this.host.submitInput(body.clientId, body.input));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/commands") {
        const body = await readJson(request) as GatewayCommandEnvelope;
        json(response, 200, await this.host.executeCommand(body));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/executors/open") {
        const body = await readJson(request) as {
          clientId: string;
          worklineId?: string;
        };
        json(response, 200, this.host.openExecutor(body.clientId, body.worklineId));
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
        const body = await readJson(request) as { clientId: string };
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
        this.host.closeClient(clientId);
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/stop") {
        json(response, 200, { ok: true });
        void this.stop("admin-stop");
        return;
      }

      json(response, 404, { error: "未找到接口。" });
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
