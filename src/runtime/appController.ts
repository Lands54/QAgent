import { EventEmitter } from "node:events";

import { AgentManager } from "./agentManager.js";
import { CommandService } from "../command/index.js";
import {
  defaultBaseUrlForProvider,
  loadRuntimeConfig,
  persistGlobalModelConfig,
  persistProjectModelConfig,
} from "../config/index.js";
import { PromptAssembler } from "../context/index.js";
import { createMemorySessionAssetProvider } from "../memory/index.js";
import { createModelClient } from "../model/index.js";
import { SessionService } from "../session/index.js";
import { SkillRegistry } from "../skills/index.js";
import { ApprovalPolicy } from "../tool/index.js";
import type {
  ApprovalMode,
  CliOptions,
  CommandRequest,
  CommandResult,
  ModelClient,
  ModelProvider,
  RuntimeEvent,
  RuntimeConfig,
  UIMessage,
} from "../types.js";
import { createId } from "../utils/index.js";
import { AppStateAssembler } from "./application/appStateAssembler.js";
import {
  createEmptyState,
  type AppState,
} from "./appState.js";
import { SlashCommandBus } from "./slashCommandBus.js";

type Listener = (state: AppState) => void;
type RuntimeEventListener = (event: RuntimeEvent) => void;

export class AppController {
  public static async create(cliOptions: CliOptions): Promise<AppController> {
    const config = await loadRuntimeConfig(cliOptions);
    const controller = new AppController(config);
    await controller.initialize();
    return controller;
  }

  private readonly events = new EventEmitter();
  private readonly sessionService: SessionService;
  private readonly skillRegistry: SkillRegistry;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly promptAssembler = new PromptAssembler();
  private readonly agentManager: AgentManager;
  private readonly appStateAssembler = new AppStateAssembler();
  private modelClient: ModelClient;
  private state: AppState;
  private slashBus?: SlashCommandBus;
  private readonly commandService: CommandService;
  private exitResolver?: () => void;
  private readonly exitPromise: Promise<void>;

  private constructor(private readonly config: RuntimeConfig) {
    this.state = createEmptyState(config.cwd);
    this.sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
      createMemorySessionAssetProvider({
        projectMemoryDir: config.resolvedPaths.projectMemoryDir,
        globalMemoryDir: config.resolvedPaths.globalMemoryDir,
      }),
    ], {
      ownerKind: "app-controller",
    });
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
    this.commandService = new CommandService({
      getSessionId: () => this.state.sessionId,
      getActiveHeadId: () => this.state.activeWorkingHeadId,
      getActiveAgentId: () => this.state.activeAgentId,
      getShellCwd: () => this.state.shellCwd,
      getHookStatus: () => this.agentManager.getHookStatus(),
      getDebugStatus: async () => this.agentManager.getDebugStatus(),
      getApprovalMode: () => this.approvalPolicy.getMode(),
      getModelStatus: () => this.getModelStatus(),
      getStatusLine: () =>
        `status=${this.state.status.mode} | detail=${this.state.status.detail} | workline=${this.state.activeWorklineName ?? "N/A"} | session=${this.state.sessionId} | bookmark=${this.state.activeBookmarkLabel ?? "N/A"} | shell=${this.state.shellCwd}`,
      getAvailableSkills: () => this.skillRegistry.getAll(),
      setApprovalMode: async (mode) => {
        await this.setApprovalMode(mode);
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
        await this.agentManager.setUiContextEnabled(enabled);
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
      listMemory: async (limit) => this.agentManager.listMemory(limit),
      saveMemory: async (input) => this.agentManager.saveMemory(input),
      showMemory: async (id) => this.agentManager.showMemory(id),
      getWorklineStatus: async (worklineId) => this.agentManager.getWorklineStatus(worklineId),
      listWorklines: async () => this.agentManager.listWorklines(),
      createWorkline: async (name) => this.agentManager.createWorkline(name),
      switchWorkline: async (worklineId) => this.agentManager.switchWorkline(worklineId),
      switchWorklineRelative: async (offset) => this.agentManager.switchWorklineRelative(offset),
      closeWorkline: async (worklineId) => this.agentManager.closeWorkline(worklineId),
      detachWorkline: async (worklineId) => this.agentManager.detachWorkline(worklineId),
      mergeWorkline: async (source) => this.agentManager.mergeWorkline(source),
      getBookmarkStatus: async () => this.agentManager.getBookmarkStatus(),
      listBookmarks: async () => this.agentManager.listBookmarks(),
      createBookmark: async (name) => this.agentManager.createBookmark(name),
      createTagBookmark: async (name) => this.agentManager.createTagBookmark(name),
      switchBookmark: async (bookmark) => this.agentManager.switchBookmark(bookmark),
      mergeBookmark: async (source) => this.agentManager.mergeBookmark(source),
      getExecutorStatus: async (executorId) => this.agentManager.getExecutorStatus(executorId),
      listExecutors: async () => this.agentManager.listExecutors(),
      interruptExecutor: async (executorId) => this.agentManager.interruptExecutor(executorId),
      resumeExecutor: async (executorId) => this.agentManager.resumeExecutor(executorId),
      listSessionCommits: async (limit) => this.agentManager.listSessionCommits(limit),
      listSessionGraphLog: async (limit) => this.agentManager.listSessionGraphLog(limit),
      listSessionLog: async (limit) => this.agentManager.listSessionLog(limit),
      compactSession: async () => this.agentManager.compactSession(),
      resetModelContext: async () => this.agentManager.resetActiveAgentModelContext(),
      commitSession: async (message) => this.agentManager.commitSession(message),
      clearHelperAgents: async () => this.agentManager.clearHelperAgents(),
      clearLegacyAgents: async () => this.agentManager.clearLegacyAgents(),
      clearUi: async () => this.agentManager.clearActiveAgentUi(),
      runPrompt: async (prompt, input) =>
        this.agentManager.runAgentPrompt(prompt, {
          agentId: input?.agentId,
          approvalMode: input?.approvalMode,
        }),
      getPendingApproval: async (input) =>
        this.agentManager.getPendingApprovalCheckpoint(input),
      resolvePendingApproval: async (approved, input) =>
        this.agentManager.resolvePendingApprovalCheckpoint(approved, input),
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });
  }

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
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    const slashResult = await this.getSlashBus().executeDetailed(trimmed);
    if (slashResult.handled) {
      if (slashResult.request && slashResult.result) {
        this.emitCommandLifecycleEvents(slashResult.request, slashResult.result);
      }
      const shouldKeepCommandOutOfModelContext =
        slashResult.request?.domain === "session"
        && slashResult.request.action === "reset-context";
      await this.agentManager.recordSlashCommandOnActiveAgent(
        trimmed,
        slashResult.messages,
        undefined,
        {
          includeInModelContext: !shouldKeepCommandOutOfModelContext,
        },
      );
      if (slashResult.clearUi) {
        await this.agentManager.clearActiveAgentUi();
      }
      if (slashResult.exitRequested) {
        await this.requestExit();
      }
      return;
    }

    this.submitInputToActiveAgent(trimmed);
  }

  public async executeCommand(request: CommandRequest): Promise<CommandResult> {
    const result = await this.commandService.execute(request);
    this.emitCommandLifecycleEvents(request, result);
    return result;
  }

  public async approvePendingRequest(approved: boolean): Promise<void> {
    await this.agentManager.approvePendingRequest(approved);
  }

  public async requestExit(): Promise<void> {
    await this.agentManager.flushCheckpointsOnExit();
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
    await this.agentManager.dispose();
  }

  public async interruptAgent(): Promise<void> {
    await this.agentManager.interruptAgent();
  }

  public async resumeAgent(): Promise<void> {
    await this.agentManager.resumeAgent();
  }

  public async switchAgent(agentId: string): Promise<void> {
    await this.agentManager.switchAgent(agentId);
  }

  public async switchAgentRelative(offset: number): Promise<void> {
    await this.agentManager.switchAgentRelative(offset);
  }

  public async setApprovalMode(mode: ApprovalMode): Promise<void> {
    this.approvalPolicy.setMode(mode);
    this.refreshState();
  }

  public getModelStatus(): {
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

  public async setModelProvider(provider: ModelProvider): Promise<void> {
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

  public async setModelName(model: string): Promise<void> {
    this.assertModelConfigMutable();
    this.config.model.model = model;
    await persistProjectModelConfig(this.config.resolvedPaths, {
      model,
    });
    await this.rebuildModelRuntime();
  }

  public async setModelApiKey(apiKey: string): Promise<void> {
    this.assertModelConfigMutable();
    this.config.model.apiKey = apiKey;
    await persistGlobalModelConfig(this.config.resolvedPaths, {
      apiKey,
    });
    await this.rebuildModelRuntime();
  }

  private async initialize(): Promise<void> {
    await this.skillRegistry.refresh();
    const initialized = await this.agentManager.initialize({
      cwd: this.config.cwd,
      shellCwd: this.config.cwd,
      approvalMode: this.config.tool.approvalMode,
      resumeSessionId: this.config.cli.resumeSessionId,
    });
    this.agentManager.subscribe(() => {
      this.refreshState();
    });
    this.agentManager.subscribeRuntimeEvents((event) => {
      this.emitRuntimeEvent(event);
    });

    this.slashBus = new SlashCommandBus(this.commandService);

    this.refreshState(initialized.infoMessage);
  }

  private getSlashBus(): SlashCommandBus {
    if (!this.slashBus) {
      throw new Error("SlashCommandBus 尚未初始化");
    }
    return this.slashBus;
  }

  private assertModelConfigMutable(): void {
    if (this.agentManager.hasBusyAgents()) {
      throw new Error("请先让所有 Agent 处于空闲状态，再修改模型配置。");
    }
  }

  private submitInputToActiveAgent(input: string): void {
    void this.agentManager.submitInputToActiveAgent(input).catch((error) => {
      const detail = formatControllerError(error);
      const content = `发送输入失败：${detail}`;
      void this.appendActiveAgentError(content, detail).catch(() => {
        this.applyLocalError(content, detail);
      });
    });
  }

  private async appendActiveAgentError(content: string, detail: string): Promise<void> {
    await this.agentManager.appendUiMessagesToActiveAgent([
      createErrorMessage(content),
    ]);
    this.applyLocalError(content, detail);
  }

  private applyLocalError(content: string, detail: string): void {
    const lastMessage = this.state.uiMessages.at(-1);
    const shouldAppendMessage = !(
      lastMessage?.role === "error"
      && lastMessage.title === "Agent"
      && lastMessage.content === content
    );
    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      status: {
        mode: "error",
        detail,
        updatedAt: now,
      },
      uiMessages: shouldAppendMessage
        ? [
            ...this.state.uiMessages,
            createErrorMessage(content, now),
          ]
        : this.state.uiMessages,
    };
    this.events.emit("state", this.state);
  }

  private async rebuildModelRuntime(): Promise<void> {
    this.modelClient = createModelClient(this.config.model);
    await this.agentManager.rebuildModelRuntime(this.config, this.modelClient);
    this.refreshState();
  }

  private refreshState(infoMessage?: string): void {
    const activeRuntime = this.agentManager.getActiveRuntime();
    const activeView = activeRuntime.getViewState();
    const pendingApprovals = Object.fromEntries(
      this.agentManager
        .listAgents()
        .filter((agent) => agent.pendingApproval)
        .map((agent) => [agent.id, agent.pendingApproval as NonNullable<typeof agent.pendingApproval>]),
    );
    this.state = this.appStateAssembler.build({
      cwd: this.config.cwd,
      previousState: this.state,
      activeRuntime,
      activeView,
      approvalMode: this.approvalPolicy.getMode(),
      availableSkills: this.skillRegistry.getAll(),
      pendingApprovals,
      agents: this.agentManager.listAgents(),
      worklines: this.agentManager.listWorklines().worklines,
      executors: this.agentManager.listExecutors().executors,
      bookmarks: [],
      infoMessage,
      autoCompactThresholdTokens: this.config.runtime.autoCompactThresholdTokens,
    });
    this.events.emit("state", this.state);
  }

  private emitRuntimeEvent(event: RuntimeEvent): void {
    this.events.emit("runtime-event", event);
  }

  private emitCommandLifecycleEvents(
    request: CommandRequest,
    result: CommandResult,
  ): void {
    if (result.status === "success") {
      if (request.domain === "bookmark") {
        this.emitRuntimeEvent({
          id: `event-command-session-${Date.now()}`,
          type: "session.changed",
          createdAt: new Date().toISOString(),
          sessionId: this.state.sessionId,
          worklineId: this.state.activeWorklineId,
          executorId: this.state.activeExecutorId,
          headId: this.state.activeWorkingHeadId,
          agentId: this.state.activeAgentId,
          payload: {
            action: request.action,
            ref: (result.payload as { ref?: AppState["sessionRef"] } | undefined)?.ref,
          },
        });
      }
      if (request.domain === "work") {
        this.emitRuntimeEvent({
          id: `event-command-agent-${Date.now()}`,
          type: "workline.changed",
          createdAt: new Date().toISOString(),
          sessionId: this.state.sessionId,
          worklineId: this.state.activeWorklineId,
          executorId: this.state.activeExecutorId,
          headId: this.state.activeWorkingHeadId,
          agentId: this.state.activeAgentId,
          payload: {
            action: request.action,
            workline: (result.payload as { workline?: AppState["worklines"][number] } | undefined)?.workline,
          },
        });
      }
    }
    this.emitRuntimeEvent({
      id: `event-command-complete-${Date.now()}`,
      type: "command.completed",
      createdAt: new Date().toISOString(),
      sessionId: this.state.sessionId,
      worklineId: this.state.activeWorklineId,
      executorId: this.state.activeExecutorId,
      headId: this.state.activeWorkingHeadId,
      agentId: this.state.activeAgentId,
      payload: {
        domain: request.domain,
        status: result.status,
        code: result.code,
        result,
      },
    });
  }
}

function formatControllerError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function createErrorMessage(content: string, createdAt = new Date().toISOString()): UIMessage {
  return {
    id: createId("ui"),
    role: "error",
    title: "Agent",
    content,
    createdAt,
  };
}

export async function createAppController(
  cliOptions: CliOptions,
): Promise<AppController> {
  return AppController.create(cliOptions);
}
