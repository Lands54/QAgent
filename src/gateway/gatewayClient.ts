import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadRuntimeConfig } from "../config/index.js";
import type { AppControllerLike, AppState } from "../runtime/index.js";
import { createEmptyState } from "../runtime/index.js";
import type {
  CliOptions,
  CommandRequest,
  CommandResult,
  RuntimeConfig,
  RuntimeEvent,
} from "../types.js";
import { createId, getBuildInfo } from "../utils/index.js";
import { clearGatewayManifest, readGatewayManifest } from "./manifest.js";
import { GatewayServer } from "./gatewayServer.js";
import type {
  GatewayCommandEnvelope,
  GatewayConnectionInput,
  GatewayHealthResponse,
  GatewayManifest,
  GatewayOpenClientResponse,
  GatewaySseEvent,
} from "./types.js";

type Listener = (state: AppState) => void;
type RuntimeEventListener = (event: RuntimeEvent) => void;

interface BackendTransport {
  openClient(clientLabel: "cli" | "tui" | "api"): Promise<GatewayOpenClientResponse>;
  submitInput(clientId: string, input: string): Promise<{ exitRequested?: boolean }>;
  executeCommand(clientId: string, request: CommandRequest): Promise<CommandResult>;
  closeClient(clientId: string): Promise<void>;
  openEventStream(
    clientId: string,
    onEvent: (event: GatewaySseEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  heartbeatExecutor(executorId: string, clientId: string): Promise<void>;
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

function authHeaders(token?: string): Record<string, string> | undefined {
  if (!token) {
    return undefined;
  }
  return {
    authorization: `Bearer ${token}`,
  };
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

function isGatewayCompatible(
  config: RuntimeConfig,
  health: GatewayHealthResponse,
): boolean {
  const buildInfo = getBuildInfo();
  return (
    health.version === buildInfo.version
    && health.buildSha === buildInfo.buildSha
    && health.workspaceId === (config.gateway.workspaceId ?? "local")
  );
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
  if (cliOptions.transportMode) {
    args.push("--transport", cliOptions.transportMode);
  }
  if (cliOptions.workspaceId) {
    args.push("--workspace", cliOptions.workspaceId);
  }
  if (cliOptions.edgeBaseUrl) {
    args.push("--edge-url", cliOptions.edgeBaseUrl);
  }
  if (cliOptions.apiToken) {
    args.push("--api-token", cliOptions.apiToken);
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
  if (manifest) {
    const health = await pingGateway(manifest.baseUrl);
    if (health && isGatewayCompatible(config, health)) {
      return {
        manifest,
        initialState: createEmptyState(config.cwd),
      };
    }
    if (health) {
      try {
        await fetchJson(`${manifest.baseUrl}/api/admin/stop`, {
          method: "POST",
        });
      } catch {
        // ignore restart failures
      }
    }
    await clearGatewayManifest(sessionRoot);
  }
  await spawnGatewayProcess({
    ...cliOptions,
    transportMode: "local",
  });

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

class LocalGatewayTransport implements BackendTransport {
  public static async create(
    cliOptions: CliOptions,
  ): Promise<{
    initialState: AppState;
    transport: LocalGatewayTransport;
  }> {
    const { manifest, initialState } = await ensureGatewayManifest(cliOptions);
    return {
      initialState,
      transport: new LocalGatewayTransport(manifest.baseUrl),
    };
  }

  private constructor(private readonly baseUrl: string) {}

  public async openClient(clientLabel: "cli" | "tui" | "api"): Promise<GatewayOpenClientResponse> {
    return fetchJson<GatewayOpenClientResponse>(`${this.baseUrl}/api/clients/open`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientLabel }),
    });
  }

  public async submitInput(
    clientId: string,
    input: string,
  ): Promise<{ exitRequested?: boolean }> {
    return fetchJson<{ exitRequested?: boolean }>(`${this.baseUrl}/api/input`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        input,
      }),
    });
  }

  public async executeCommand(clientId: string, request: CommandRequest): Promise<CommandResult> {
    const envelope: GatewayCommandEnvelope = {
      commandId: createId("cmd"),
      clientId,
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

  public async closeClient(clientId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/clients/${clientId}`, {
      method: "DELETE",
    });
  }

  public async openEventStream(
    clientId: string,
    onEvent: (event: GatewaySseEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/events?clientId=${encodeURIComponent(clientId)}`,
      {
        signal,
        headers: {
          accept: "text/event-stream",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`连接 gateway SSE 失败：${response.status}`);
    }
    await readSseStream(response, onEvent);
  }

  public async heartbeatExecutor(executorId: string, clientId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/executors/${executorId}/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientId,
      }),
    });
  }
}

class RemoteEdgeTransport implements BackendTransport {
  public constructor(
    private readonly edgeBaseUrl: string,
    private readonly workspaceId: string,
    private readonly apiToken: string,
  ) {}

  private get workspaceBaseUrl(): string {
    return `${this.edgeBaseUrl}/v1/workspaces/${encodeURIComponent(this.workspaceId)}`;
  }

  public async openClient(clientLabel: "cli" | "tui" | "api"): Promise<GatewayOpenClientResponse> {
    return fetchJson<GatewayOpenClientResponse>(`${this.workspaceBaseUrl}/clients/open`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(this.apiToken),
      },
      body: JSON.stringify({ clientLabel }),
    });
  }

  public async submitInput(
    clientId: string,
    input: string,
  ): Promise<{ exitRequested?: boolean }> {
    return fetchJson<{ exitRequested?: boolean }>(`${this.workspaceBaseUrl}/input`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(this.apiToken),
      },
      body: JSON.stringify({
        clientId,
        input,
      }),
    });
  }

  public async executeCommand(clientId: string, request: CommandRequest): Promise<CommandResult> {
    const envelope: GatewayCommandEnvelope = {
      commandId: createId("cmd"),
      clientId,
      request,
    };
    const result = await fetchJson<{
      commandId: string;
      result: CommandResult;
    }>(`${this.workspaceBaseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(this.apiToken),
      },
      body: JSON.stringify(envelope),
    });
    return result.result;
  }

  public async closeClient(clientId: string): Promise<void> {
    await fetch(`${this.workspaceBaseUrl}/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeaders(this.apiToken),
    });
  }

  public async openEventStream(
    clientId: string,
    onEvent: (event: GatewaySseEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      `${this.workspaceBaseUrl}/events?clientId=${encodeURIComponent(clientId)}`,
      {
        signal,
        headers: {
          accept: "text/event-stream",
          ...authHeaders(this.apiToken),
        },
      },
    );
    if (!response.ok) {
      throw new Error(`连接 edge SSE 失败：${response.status}`);
    }
    await readSseStream(response, onEvent);
  }

  public async heartbeatExecutor(executorId: string, clientId: string): Promise<void> {
    await fetch(`${this.workspaceBaseUrl}/executors/${executorId}/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(this.apiToken),
      },
      body: JSON.stringify({
        clientId,
      }),
    });
  }
}

async function createBackendTransport(
  input: GatewayConnectionInput,
): Promise<{
  initialState: AppState;
  transport: BackendTransport;
}> {
  const config = await loadRuntimeConfig(input.cliOptions);
  if (config.gateway.transportMode === "remote") {
    if (
      !config.gateway.workspaceId
      || !config.gateway.edgeBaseUrl
      || !config.gateway.apiToken
    ) {
      throw new Error("远程模式需要 workspaceId、edgeBaseUrl、apiToken。");
    }
    return {
      initialState: createEmptyState(config.cwd),
      transport: new RemoteEdgeTransport(
        config.gateway.edgeBaseUrl,
        config.gateway.workspaceId,
        config.gateway.apiToken,
      ),
    };
  }
  return LocalGatewayTransport.create(input.cliOptions);
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

export class BackendClientController implements AppControllerLike {
  public static async create(
    input: GatewayConnectionInput,
  ): Promise<BackendClientController> {
    const { initialState, transport } = await createBackendTransport(input);
    const opened = await transport.openClient(input.clientLabel);
    const controller = new BackendClientController(
      transport,
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

  protected constructor(
    private readonly transport: BackendTransport,
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
    const result = await this.transport.submitInput(this.clientId, input);
    if (result.exitRequested) {
      await this.requestExit();
    }
  }

  public async executeCommand(request: CommandRequest): Promise<CommandResult> {
    return this.transport.executeCommand(this.clientId, request);
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
      await this.transport.closeClient(this.clientId);
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
    void this.transport.openEventStream(
      this.clientId,
      (event) => {
        if (event.type === "state.snapshot") {
          this.state = event.payload.state;
          this.events.emit("state", this.state);
          return;
        }
        if (event.type === "runtime.event") {
          this.events.emit("runtime-event", event.payload.event);
          return;
        }
        if (event.type === "gateway.stopping" || event.type === "gateway.disconnected") {
          void this.requestExit();
        }
      },
      this.abortController.signal,
    ).catch(() => {});
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.state.activeExecutorId) {
        return;
      }
      void this.transport.heartbeatExecutor(
        this.state.activeExecutorId,
        this.clientId,
      ).catch(() => {});
    }, 5_000);
    this.heartbeatTimer.unref?.();
  }
}

export { BackendClientController as GatewayClientController };
