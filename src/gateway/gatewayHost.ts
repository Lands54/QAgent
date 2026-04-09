import { EventEmitter } from "node:events";

import {
  defaultBaseUrlForProvider,
  loadRuntimeConfig,
  persistGlobalModelConfig,
  persistProjectModelConfig,
} from "../config/index.js";
import { PromptAssembler } from "../context/index.js";
import { createMemorySessionAssetProvider } from "../memory/index.js";
import { createModelClient } from "../model/index.js";
import {
  AgentManager,
  AppStateAssembler,
  createEmptyState,
  SlashCommandBus,
  type AppState,
} from "../runtime/index.js";
import { SessionService } from "../session/index.js";
import { SkillRegistry } from "../skills/index.js";
import { ApprovalPolicy } from "../tool/index.js";
import type {
  CliOptions,
  CommandRequest,
  CommandResult,
  ModelClient,
  ModelProvider,
  RuntimeConfig,
  RuntimeEvent,
} from "../types.js";
import { createId } from "../utils/index.js";
import { CommandService } from "../command/index.js";
import { ClientSessionService } from "./clientSessionService.js";
import type {
  GatewayClientSession,
  GatewayCommandEnvelope,
  GatewayCommandResult,
  GatewayOpenClientRequest,
  GatewayOpenClientResponse,
  GatewaySseEvent,
  GatewayStateResponse,
} from "./types.js";

type GatewayEventListener = (event: GatewaySseEvent) => void;

interface CommandContext {
  clientId: string;
  commandId: string;
}

export class GatewayHost {
  public static async create(cliOptions: CliOptions): Promise<GatewayHost> {
    const config = await loadRuntimeConfig(cliOptions);
    const host = new GatewayHost(config);
    await host.initialize();
    return host;
  }

  private readonly events = new EventEmitter();
  private readonly sessionService: SessionService;
  private readonly skillRegistry: SkillRegistry;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly promptAssembler = new PromptAssembler();
  private readonly agentManager: AgentManager;
  private readonly appStateAssembler = new AppStateAssembler();
  private readonly clientSessions = new ClientSessionService();
  private readonly stateByClient = new Map<string, AppState>();
  private readonly commandContextsByExecutor = new Map<string, CommandContext>();
  private readonly slashBusByClient = new Map<string, SlashCommandBus>();
  private modelClient: ModelClient;

  private constructor(private readonly config: RuntimeConfig) {
    this.sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ]);
    this.skillRegistry = new SkillRegistry(config.resolvedPaths);
    this.approvalPolicy = new ApprovalPolicy(config.tool.approvalMode);
    this.modelClient = createModelClient(config.model);
    this.agentManager = new AgentManager(
      config,
      this.modelClient,
      this.promptAssembler,
      this.sessionService,
      this.approvalPolicy,
      () => this.skillRegistry.getAll(),
    );
  }

  public subscribe(listener: GatewayEventListener): () => void {
    this.events.on("event", listener);
    return () => {
      this.events.off("event", listener);
    };
  }

  public getClientCount(): number {
    return this.clientSessions.listClients().length;
  }

  public getConfig(): RuntimeConfig {
    return this.config;
  }

  public getLeaseCount(): number {
    return this.clientSessions.getLeaseCount();
  }

  public async openClient(
    input: GatewayOpenClientRequest,
  ): Promise<GatewayOpenClientResponse> {
    const clientId = input.clientId ?? createId("client");
    this.clientSessions.openClient({
      clientId,
      clientLabel: input.clientLabel,
    });
    this.ensureClientExecutor(clientId);
    const state = await this.buildState(clientId);
    this.emitStateSnapshot(clientId, state);
    return {
      clientId,
      state,
    };
  }

  public closeClient(clientId: string): void {
    this.clientSessions.closeClient(clientId);
    this.stateByClient.delete(clientId);
    this.slashBusByClient.delete(clientId);
  }

  public async getState(clientId: string): Promise<GatewayStateResponse> {
    return {
      state: await this.buildState(clientId),
    };
  }

  public openExecutor(clientId: string, worklineId?: string): {
    executorId: string;
    worklineId: string;
  } {
    const client = this.clientSessions.requireClient(clientId);
    const targetWorklineId =
      worklineId
      ?? client.activeWorklineId
      ?? this.pickAttachableWorklineId(clientId);
    const runtime = this.agentManager.getRuntimeByWorklineId(targetWorklineId);
    this.clientSessions.attachExecutor({
      clientId,
      executorId: runtime.agentId,
      worklineId: runtime.headId,
    });
    return {
      executorId: runtime.agentId,
      worklineId: runtime.headId,
    };
  }

  public heartbeatExecutor(executorId: string, clientId: string): void {
    this.clientSessions.heartbeatExecutor(executorId, clientId);
  }

  public releaseExecutor(executorId: string, clientId?: string): void {
    this.clientSessions.releaseExecutor(executorId, clientId);
  }

  public sweepExpiredLeases(ttlMs: number): void {
    this.clientSessions.sweepExpiredLeases(ttlMs);
  }

  public async submitInput(
    clientId: string,
    input: string,
  ): Promise<{
    handled: boolean;
    exitRequested?: boolean;
  }> {
    const trimmed = input.trim();
    if (!trimmed) {
      return { handled: true };
    }
    const client = this.clientSessions.requireClient(clientId);
    const runtime = this.ensureClientRuntime(clientId);
    const slashBus = this.getSlashBus(clientId);
    const slashResult = await slashBus.executeDetailed(trimmed);
    if (slashResult.handled) {
      if (slashResult.request && slashResult.result) {
        await this.emitCommandLifecycleEvents(
          clientId,
          createId("cmd"),
          slashResult.request,
          slashResult.result,
        );
      }
      await this.agentManager.recordSlashCommandOnActiveAgent(
        trimmed,
        slashResult.messages,
        client.activeExecutorId,
      );
      if (slashResult.clearUi) {
        await this.agentManager.clearActiveAgentUi(client.activeExecutorId);
      }
      return {
        handled: true,
        exitRequested: slashResult.exitRequested,
      };
    }

    await this.agentManager.submitInputToAgent(runtime.agentId, trimmed, {
      approvalMode: "interactive",
    });
    return {
      handled: false,
    };
  }

  public async executeCommand(
    envelope: GatewayCommandEnvelope,
  ): Promise<GatewayCommandResult> {
    this.clientSessions.touchClient(envelope.clientId);
    const client = this.clientSessions.requireClient(envelope.clientId);
    const runtime = this.ensureClientRuntime(envelope.clientId);
    const targetExecutorId =
      envelope.executorId
      ?? ("agentId" in envelope.request ? envelope.request.agentId : undefined)
      ?? client.activeExecutorId
      ?? runtime.agentId;

    this.commandContextsByExecutor.set(targetExecutorId, {
      clientId: envelope.clientId,
      commandId: envelope.commandId,
    });

    try {
      const result = await this.createCommandService(envelope.clientId)
        .execute(envelope.request);
      await this.syncClientContextAfterCommand(envelope.clientId, envelope.request, result);
      await this.emitCommandLifecycleEvents(
        envelope.clientId,
        envelope.commandId,
        envelope.request,
        result,
      );
      return {
        commandId: envelope.commandId,
        result,
      };
    } finally {
      this.commandContextsByExecutor.delete(targetExecutorId);
    }
  }

  public async dispose(): Promise<void> {
    await this.agentManager.dispose();
  }

  private async initialize(): Promise<void> {
    await this.skillRegistry.refresh();
    await this.agentManager.initialize({
      cwd: this.config.cwd,
      shellCwd: this.config.cwd,
      approvalMode: this.config.tool.approvalMode,
      resumeSessionId: this.config.cli.resumeSessionId,
    });
    this.agentManager.subscribe(() => {
      void this.refreshAllClientStates();
    });
    this.agentManager.subscribeRuntimeEvents((event) => {
      this.forwardRuntimeEvent(event);
    });
  }

  private ensureClientExecutor(clientId: string): void {
    const client = this.clientSessions.requireClient(clientId);
    if (client.activeExecutorId && this.clientSessions.getLeaseByExecutorId(client.activeExecutorId)) {
      return;
    }
    this.openExecutor(clientId, client.activeWorklineId);
  }

  private ensureClientRuntime(clientId: string) {
    this.ensureClientExecutor(clientId);
    const client = this.clientSessions.requireClient(clientId);
    if (!client.activeExecutorId) {
      throw new Error(`client ${clientId} 当前没有活动执行器。`);
    }
    return this.agentManager.getRuntime(client.activeExecutorId);
  }

  private pickAttachableWorklineId(clientId: string): string {
    const activeWorklineId = this.agentManager.getActiveRuntime().headId;
    const worklines = this.agentManager.listWorklines().worklines
      .filter((workline) => !workline.helperType && workline.status !== "closed");
    const preferred = worklines.find((workline) => {
      const lease = this.clientSessions.getLeaseByWorklineId(workline.id);
      return workline.id === activeWorklineId
        && (!lease || lease.clientId === clientId);
    });
    if (preferred) {
      return preferred.id;
    }
    const attachable = worklines.find((workline) => {
      const lease = this.clientSessions.getLeaseByWorklineId(workline.id);
      return !lease || lease.clientId === clientId;
    });
    if (!attachable) {
      throw new Error("当前没有可附着的工作线。");
    }
    return attachable.id;
  }

  private getCachedState(clientId: string): AppState {
    return this.stateByClient.get(clientId) ?? createEmptyState(this.config.cwd);
  }

  private async buildState(clientId: string, infoMessage?: string): Promise<AppState> {
    const runtime = this.ensureClientRuntime(clientId);
    const activeView = runtime.getViewState();
    const pendingApprovals = Object.fromEntries(
      this.agentManager
        .listAgents()
        .filter((agent) => agent.pendingApproval)
        .map((agent) => [agent.id, agent.pendingApproval as NonNullable<typeof agent.pendingApproval>]),
    );
    const worklines = this.agentManager.listWorklines().worklines.map((workline) => ({
      ...workline,
      active: workline.id === runtime.headId,
    }));
    const executors = this.agentManager.listExecutors().executors.map((executor) => ({
      ...executor,
      active: executor.executorId === runtime.agentId,
    }));
    const bookmarks = (await this.agentManager.listBookmarks(runtime.agentId)).bookmarks;
    const state = this.appStateAssembler.build({
      cwd: this.config.cwd,
      previousState: this.getCachedState(clientId),
      activeRuntime: runtime,
      activeView,
      approvalMode: this.approvalPolicy.getMode(),
      availableSkills: this.skillRegistry.getAll(),
      pendingApprovals,
      agents: this.agentManager.listAgents(),
      worklines,
      executors,
      bookmarks,
      infoMessage,
      autoCompactThresholdTokens: this.config.runtime.autoCompactThresholdTokens,
    });
    this.stateByClient.set(clientId, state);
    return state;
  }

  private async refreshAllClientStates(): Promise<void> {
    await Promise.all(
      this.clientSessions.listClients().map(async (client) => {
        const state = await this.buildState(client.clientId);
        this.emitStateSnapshot(client.clientId, state);
      }),
    );
  }

  private emitStateSnapshot(clientId: string, state: AppState): void {
    this.emitGatewayEvent({
      id: createId("gw"),
      type: "state.snapshot",
      createdAt: new Date().toISOString(),
      clientId,
      payload: {
        state,
      },
    });
  }

  private forwardRuntimeEvent(event: RuntimeEvent): void {
    const commandContext = this.commandContextsByExecutor.get(event.executorId);
    const targets = new Set<string>();
    if (commandContext) {
      targets.add(commandContext.clientId);
    }
    for (const client of this.clientSessions.listClients()) {
      if (
        client.activeExecutorId === event.executorId
        || client.activeWorklineId === event.worklineId
      ) {
        targets.add(client.clientId);
      }
    }
    if (targets.size === 0) {
      return;
    }
    for (const clientId of targets) {
      this.emitGatewayEvent({
        id: createId("gw"),
        type: "runtime.event",
        createdAt: new Date().toISOString(),
        clientId,
        commandId: commandContext?.commandId,
        payload: {
          event: {
            ...event,
            clientId,
            commandId: commandContext?.commandId,
          },
        },
      });
    }
  }

  private emitGatewayEvent(event: GatewaySseEvent): void {
    this.events.emit("event", event);
  }

  private getSlashBus(clientId: string): SlashCommandBus {
    const cached = this.slashBusByClient.get(clientId);
    if (cached) {
      return cached;
    }
    const slashBus = new SlashCommandBus(this.createCommandService(clientId));
    this.slashBusByClient.set(clientId, slashBus);
    return slashBus;
  }

  private createCommandService(clientId: string): CommandService {
    return new CommandService({
      getSessionId: () => this.ensureClientRuntime(clientId).sessionId,
      getActiveHeadId: () => this.ensureClientRuntime(clientId).headId,
      getActiveAgentId: () => this.ensureClientRuntime(clientId).agentId,
      getShellCwd: () => this.ensureClientRuntime(clientId).getShellCwd(),
      getHookStatus: () => this.agentManager.getHookStatus(),
      getDebugStatus: async () => this.agentManager.getDebugStatus(),
      getApprovalMode: () => this.approvalPolicy.getMode(),
      getModelStatus: () => this.getModelStatus(),
      getStatusLine: () => {
        const state = this.getCachedState(clientId);
        return `status=${state.status.mode} | detail=${state.status.detail} | workline=${state.activeWorklineName ?? "N/A"} | session=${state.sessionId} | bookmark=${state.activeBookmarkLabel ?? "N/A"} | shell=${state.shellCwd}`;
      },
      getAvailableSkills: () => this.skillRegistry.getAll(),
      setApprovalMode: async (mode) => {
        this.approvalPolicy.setMode(mode);
        await this.refreshAllClientStates();
      },
      setFetchMemoryHookEnabled: async (enabled) => {
        this.agentManager.setFetchMemoryHookEnabled(enabled);
      },
      setSaveMemoryHookEnabled: async (enabled) => {
        this.agentManager.setSaveMemoryHookEnabled(enabled);
      },
      setAutoCompactHookEnabled: async (enabled) => {
        this.agentManager.setAutoCompactHookEnabled(enabled);
      },
      setUiContextEnabled: async (enabled) => {
        await this.agentManager.setUiContextEnabled(
          enabled,
          this.ensureClientRuntime(clientId).agentId,
        );
      },
      setHelperAgentAutoCleanupEnabled: async (enabled) => {
        this.agentManager.setHelperAgentAutoCleanupEnabled(enabled);
      },
      setModelProvider: async (provider) => {
        await this.setModelProvider(provider);
      },
      setModelName: async (model) => {
        await this.setModelName(model);
      },
      setModelApiKey: async (apiKey) => {
        await this.setModelApiKey(apiKey);
      },
      listMemory: async (limit) => {
        return this.agentManager.listMemory(limit, this.ensureClientRuntime(clientId).agentId);
      },
      saveMemory: async (input) => {
        return this.agentManager.saveMemory(input, this.ensureClientRuntime(clientId).agentId);
      },
      showMemory: async (name) => {
        return this.agentManager.showMemory(name, this.ensureClientRuntime(clientId).agentId);
      },
      getWorklineStatus: async (worklineId) => this.agentManager.getWorklineStatus(worklineId),
      listWorklines: async () => this.agentManager.listWorklines(),
      createWorkline: async (name) => {
        const workline = await this.agentManager.createWorkline(
          name,
          this.ensureClientRuntime(clientId).agentId,
        );
        this.openExecutor(clientId, workline.id);
        return workline;
      },
      switchWorkline: async (worklineId) => {
        const workline = await this.agentManager.switchWorkline(
          worklineId,
          this.ensureClientRuntime(clientId).agentId,
        );
        this.openExecutor(clientId, workline.id);
        return workline;
      },
      switchWorklineRelative: async (offset) => {
        const workline = await this.agentManager.switchWorklineRelative(
          offset,
          this.ensureClientRuntime(clientId).agentId,
        );
        this.openExecutor(clientId, workline.id);
        return workline;
      },
      closeWorkline: async (worklineId) => {
        const workline = await this.agentManager.closeWorkline(worklineId);
        if (workline.id === this.clientSessions.requireClient(clientId).activeWorklineId) {
          this.openExecutor(clientId);
        }
        return workline;
      },
      detachWorkline: async (worklineId) => {
        return this.agentManager.detachWorkline(
          worklineId ?? this.ensureClientRuntime(clientId).headId,
        );
      },
      mergeWorkline: async (source) => {
        return this.agentManager.mergeWorkline(
          source,
          this.ensureClientRuntime(clientId).agentId,
        );
      },
      getBookmarkStatus: async () => {
        return this.agentManager.getBookmarkStatus(this.ensureClientRuntime(clientId).agentId);
      },
      listBookmarks: async () => {
        return this.agentManager.listBookmarks(this.ensureClientRuntime(clientId).agentId);
      },
      createBookmark: async (name) => {
        return this.agentManager.createBookmark(name, this.ensureClientRuntime(clientId).agentId);
      },
      createTagBookmark: async (name) => {
        return this.agentManager.createTagBookmark(name, this.ensureClientRuntime(clientId).agentId);
      },
      switchBookmark: async (bookmark) => {
        return this.agentManager.switchBookmark(bookmark, this.ensureClientRuntime(clientId).agentId);
      },
      mergeBookmark: async (source) => {
        return this.agentManager.mergeBookmark(source, this.ensureClientRuntime(clientId).agentId);
      },
      getExecutorStatus: async (executorId) => this.agentManager.getExecutorStatus(executorId),
      listExecutors: async () => this.agentManager.listExecutors(),
      interruptExecutor: async (executorId) => {
        await this.agentManager.interruptExecutor(
          executorId ?? this.ensureClientRuntime(clientId).agentId,
        );
      },
      resumeExecutor: async (executorId) => {
        await this.agentManager.resumeExecutor(
          executorId ?? this.ensureClientRuntime(clientId).agentId,
        );
      },
      listSessionCommits: async (limit) => {
        return this.agentManager.listSessionCommits(
          limit,
          this.ensureClientRuntime(clientId).agentId,
        );
      },
      listSessionGraphLog: async (limit) => this.agentManager.listSessionGraphLog(limit),
      listSessionLog: async (limit) => this.agentManager.listSessionLog(limit),
      compactSession: async () => {
        return this.agentManager.compactSession(this.ensureClientRuntime(clientId).agentId);
      },
      commitSession: async (message) => {
        return this.agentManager.commitSession(
          message,
          this.ensureClientRuntime(clientId).agentId,
        );
      },
      clearHelperAgents: async () => this.agentManager.clearHelperAgents(),
      clearLegacyAgents: async () => this.agentManager.clearLegacyAgents(),
      clearUi: async () => {
        await this.agentManager.clearActiveAgentUi(this.ensureClientRuntime(clientId).agentId);
      },
      runPrompt: async (prompt, input) =>
        this.agentManager.runAgentPrompt(prompt, {
          agentId: input?.agentId ?? this.ensureClientRuntime(clientId).agentId,
          approvalMode: input?.approvalMode,
        }),
      getPendingApproval: async (input) =>
        this.agentManager.getPendingApprovalCheckpoint({
          ...input,
          agentId: input?.agentId ?? this.ensureClientRuntime(clientId).agentId,
        }),
      resolvePendingApproval: async (approved, input) =>
        this.agentManager.resolvePendingApprovalCheckpoint(approved, {
          ...input,
          agentId: input?.agentId ?? this.ensureClientRuntime(clientId).agentId,
        }),
    });
  }

  private async syncClientContextAfterCommand(
    clientId: string,
    request: CommandRequest,
    result: CommandResult,
  ): Promise<void> {
    if (result.status !== "success") {
      return;
    }
    if (request.domain === "work") {
      if (request.action === "close") {
        const runtime = this.ensureClientRuntime(clientId);
        this.clientSessions.setClientContext(clientId, {
          activeExecutorId: runtime.agentId,
          activeWorklineId: runtime.headId,
        });
        return;
      }
      const workline = (result.payload as { workline?: { id: string } } | undefined)?.workline;
      if (workline?.id) {
        this.openExecutor(clientId, workline.id);
      }
      return;
    }
    if (request.domain === "bookmark") {
      const runtime = this.ensureClientRuntime(clientId);
      this.clientSessions.setClientContext(clientId, {
        activeExecutorId: runtime.agentId,
        activeWorklineId: runtime.headId,
      });
    }
  }

  private async emitCommandLifecycleEvents(
    clientId: string,
    commandId: string,
    request: CommandRequest,
    result: CommandResult,
  ): Promise<void> {
    const state = await this.buildState(clientId);
    const buildBaseEvent = (
      type: RuntimeEvent["type"],
      payload: RuntimeEvent["payload"],
    ): RuntimeEvent => ({
      id: createId("event"),
      type,
      createdAt: new Date().toISOString(),
      commandId,
      clientId,
      sessionId: state.sessionId,
      worklineId: state.activeWorklineId,
      executorId: state.activeExecutorId,
      headId: state.activeWorkingHeadId,
      agentId: state.activeAgentId,
      payload,
    } as RuntimeEvent);

    if (result.status === "success") {
      if (request.domain === "bookmark") {
        const ref = (result.payload as { ref?: AppState["sessionRef"] } | undefined)?.ref;
        this.forwardRuntimeEvent(buildBaseEvent("session.changed", {
          action: request.action,
          ref,
        }));
      }
      if (request.domain === "work") {
        const workline = (result.payload as { workline?: AppState["worklines"][number] } | undefined)?.workline;
        this.forwardRuntimeEvent(buildBaseEvent("workline.changed", {
          action: request.action,
          workline,
        }));
      }
    }
    this.forwardRuntimeEvent(buildBaseEvent("command.completed", {
      domain: request.domain,
      status: result.status,
      code: result.code,
      result,
    }));
  }

  private getModelStatus(): {
    provider: ModelProvider;
    model: string;
    baseUrl: string;
    apiKeyMasked?: string;
  } {
    const apiKey = this.config.model.apiKey;
    const apiKeyMasked = apiKey
      ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
      : undefined;

    return {
      provider: this.config.model.provider,
      model: this.config.model.model,
      baseUrl: this.config.model.baseUrl,
      apiKeyMasked,
    };
  }

  private assertModelConfigMutable(): void {
    if (this.agentManager.hasBusyAgents()) {
      throw new Error("请先让所有执行器处于空闲状态，再修改模型配置。");
    }
  }

  private async setModelProvider(provider: ModelProvider): Promise<void> {
    this.assertModelConfigMutable();
    this.config.model.provider = provider;
    this.config.model.baseUrl = defaultBaseUrlForProvider(provider);
    if (provider === "openrouter" && !this.config.model.appName) {
      this.config.model.appName = "QAgent CLI";
    }
    await persistProjectModelConfig(this.config.resolvedPaths, {
      provider,
      baseUrl: this.config.model.baseUrl,
    });
    await this.rebuildModelRuntime();
  }

  private async setModelName(model: string): Promise<void> {
    this.assertModelConfigMutable();
    this.config.model.model = model;
    await persistProjectModelConfig(this.config.resolvedPaths, {
      model,
    });
    await this.rebuildModelRuntime();
  }

  private async setModelApiKey(apiKey: string): Promise<void> {
    this.assertModelConfigMutable();
    this.config.model.apiKey = apiKey;
    await persistGlobalModelConfig(this.config.resolvedPaths, {
      apiKey,
    });
    await this.rebuildModelRuntime();
  }

  private async rebuildModelRuntime(): Promise<void> {
    this.modelClient = createModelClient(this.config.model);
    await this.agentManager.rebuildModelRuntime(this.config, this.modelClient);
    await this.refreshAllClientStates();
  }
}
