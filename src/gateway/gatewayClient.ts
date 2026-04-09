import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadRuntimeConfig } from "../config/index.js";
import type { AppControllerLike, AppState } from "../runtime/index.js";
import {
  createEmptyState,
} from "../runtime/index.js";
import type {
  CliOptions,
  CommandRequest,
  CommandResult,
  RuntimeEvent,
} from "../types.js";
import { createId } from "../utils/index.js";
import {
  clearGatewayManifest,
  readGatewayManifest,
} from "./manifest.js";
import { GatewayServer } from "./gatewayServer.js";
import type {
  GatewayCommandEnvelope,
  GatewayConnectionInput,
  GatewayHealthResponse,
  GatewayManifest,
  GatewayOpenClientResponse,
  GatewaySseEvent,
  GatewayStateResponse,
} from "./types.js";

type Listener = (state: AppState) => void;
type RuntimeEventListener = (event: RuntimeEvent) => void;

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

async function pingGateway(baseUrl: string): Promise<GatewayHealthResponse | undefined> {
  try {
    return await fetchJson<GatewayHealthResponse>(`${baseUrl}/api/health`);
  } catch {
    return undefined;
  }
}

async function waitForGateway(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await pingGateway(baseUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 gateway 启动超时。");
}

async function spawnGatewayProcess(cliOptions: CliOptions): Promise<void> {
  const scriptPath = fileURLToPath(new URL("../../bin/qagent.js", import.meta.url));
  const args = [scriptPath, "gateway", "serve"];
  if (cliOptions.cwd) {
    args.push("--cwd", cliOptions.cwd);
  }
  if (cliOptions.configPath) {
    args.push("--config", cliOptions.configPath);
  }
  if (cliOptions.provider) {
    args.push("--provider", cliOptions.provider);
  }
  if (cliOptions.model) {
    args.push("--model", cliOptions.model);
  }
  const child = spawn(process.execPath, args, {
    cwd: cliOptions.cwd ?? process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function ensureGatewayManifest(
  cliOptions: CliOptions,
): Promise<{
  manifest: GatewayManifest;
  initialState: AppState;
}> {
  const config = await loadRuntimeConfig(cliOptions);
  const sessionRoot = config.resolvedPaths.sessionRoot;
  let manifest = await readGatewayManifest(sessionRoot);
  if (manifest && await pingGateway(manifest.baseUrl)) {
    return {
      manifest,
      initialState: createEmptyState(config.cwd),
    };
  }
  if (manifest) {
    await clearGatewayManifest(sessionRoot);
  }
  await spawnGatewayProcess(cliOptions);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    manifest = await readGatewayManifest(sessionRoot);
    if (manifest) {
      await waitForGateway(manifest.baseUrl);
      return {
        manifest,
        initialState: createEmptyState(config.cwd),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("未能找到已启动的 gateway。");
}

async function readSseStream(
  response: Response,
  onEvent: (event: GatewaySseEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const dataLine = chunk
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) {
        continue;
      }
      onEvent(JSON.parse(dataLine.slice("data: ".length)) as GatewaySseEvent);
    }
  }
}

export async function getGatewayStatus(
  cliOptions: CliOptions,
): Promise<{
  manifest?: GatewayManifest;
  health?: GatewayHealthResponse;
}> {
  const config = await loadRuntimeConfig(cliOptions);
  const manifest = await readGatewayManifest(config.resolvedPaths.sessionRoot);
  if (!manifest) {
    return {};
  }
  return {
    manifest,
    health: await pingGateway(manifest.baseUrl),
  };
}

export async function stopGateway(cliOptions: CliOptions): Promise<boolean> {
  const status = await getGatewayStatus(cliOptions);
  if (!status.manifest) {
    return false;
  }
  if (!status.health) {
    await clearGatewayManifest(status.manifest.sessionRoot);
    return false;
  }
  await fetchJson(`${status.manifest.baseUrl}/api/admin/stop`, {
    method: "POST",
  });
  return true;
}

export async function serveGateway(cliOptions: CliOptions): Promise<void> {
  const server = await GatewayServer.create(cliOptions);
  const { baseUrl } = await server.listen();
  process.stdout.write(`gateway listening on ${baseUrl}\n`);

  const stop = async (signal: string) => {
    process.stdout.write(`stopping gateway (${signal})\n`);
    await server.stop(signal);
  };
  process.once("SIGINT", () => {
    void stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });

  await server.waitUntilStopped();
}

export class GatewayClientController implements AppControllerLike {
  public static async create(
    input: GatewayConnectionInput,
  ): Promise<GatewayClientController> {
    const { manifest, initialState } = await ensureGatewayManifest(input.cliOptions);
    const opened = await fetchJson<GatewayOpenClientResponse>(
      `${manifest.baseUrl}/api/clients/open`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientLabel: input.clientLabel,
        }),
      },
    );
    const controller = new GatewayClientController(
      manifest.baseUrl,
      opened.clientId,
      opened.state ?? initialState,
    );
    await controller.startEventStream();
    controller.startHeartbeat();
    return controller;
  }

  private readonly events = new EventEmitter();
  private readonly abortController = new AbortController();
  private readonly exitPromise = new Promise<void>((resolve) => {
    this.exitResolver = resolve;
  });
  private exitResolver?: () => void;
  private heartbeatTimer?: NodeJS.Timeout;

  private constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private state: AppState,
  ) {}

  public getState(): AppState {
    return this.state;
  }

  public subscribe(listener: Listener): () => void {
    this.events.on("state", listener);
    return () => {
      this.events.off("state", listener);
    };
  }

  public subscribeRuntimeEvents(listener: RuntimeEventListener): () => void {
    this.events.on("runtime-event", listener);
    return () => {
      this.events.off("runtime-event", listener);
    };
  }

  public async submitInput(input: string): Promise<void> {
    const result = await fetchJson<{ exitRequested?: boolean }>(`${this.baseUrl}/api/input`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientId: this.clientId,
        input,
      }),
    });
    if (result.exitRequested) {
      await this.requestExit();
    }
  }

  public async executeCommand(request: CommandRequest): Promise<CommandResult> {
    const envelope: GatewayCommandEnvelope = {
      commandId: createId("cmd"),
      clientId: this.clientId,
      request,
    };
    const result = await fetchJson<{
      commandId: string;
      result: CommandResult;
    }>(`${this.baseUrl}/api/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
    return result.result;
  }

  public async approvePendingRequest(approved: boolean): Promise<void> {
    await this.executeCommand({
      domain: "approval",
      action: approved ? "approve" : "reject",
    });
  }

  public async requestExit(): Promise<void> {
    this.state = {
      ...this.state,
      shouldExit: true,
    };
    this.events.emit("state", this.state);
    this.exitResolver?.();
  }

  public async waitForExit(): Promise<void> {
    await this.exitPromise;
  }

  public async dispose(): Promise<void> {
    this.abortController.abort();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    try {
      await fetch(`${this.baseUrl}/api/clients/${this.clientId}`, {
        method: "DELETE",
      });
    } catch {
      // ignore dispose errors
    }
  }

  public async interruptAgent(): Promise<void> {
    await this.executeCommand({
      domain: "executor",
      action: "interrupt",
    });
  }

  public async resumeAgent(): Promise<void> {
    await this.executeCommand({
      domain: "executor",
      action: "resume",
    });
  }

  public async switchAgent(agentId: string): Promise<void> {
    await this.executeCommand({
      domain: "work",
      action: "switch",
      worklineId: agentId,
    });
  }

  public async switchAgentRelative(offset: number): Promise<void> {
    await this.executeCommand({
      domain: "work",
      action: offset >= 0 ? "next" : "prev",
    });
  }

  private async startEventStream(): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/events?clientId=${encodeURIComponent(this.clientId)}`,
      {
        signal: this.abortController.signal,
        headers: {
          accept: "text/event-stream",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`连接 gateway SSE 失败：${response.status}`);
    }
    void readSseStream(response, (event) => {
      if (event.type === "state.snapshot") {
        this.state = event.payload.state;
        this.events.emit("state", this.state);
        return;
      }
      if (event.type === "runtime.event") {
        this.events.emit("runtime-event", event.payload.event);
        return;
      }
      if (event.type === "gateway.stopping") {
        void this.requestExit();
      }
    }).catch(() => {});
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.state.activeExecutorId) {
        return;
      }
      void fetch(`${this.baseUrl}/api/executors/${this.state.activeExecutorId}/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId: this.clientId,
        }),
      }).catch(() => {});
    }, 5_000);
  }
}
