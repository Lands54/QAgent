import { EventEmitter } from "node:events";

import type {
  ApprovalMode,
  CliOptions,
  ModelClient,
  ModelProvider,
  RuntimeConfig,
} from "../types.js";
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
import { createId } from "../utils/index.js";
import { AgentManager } from "./agentManager.js";
import { estimateMessagesTokens } from "./compactSessionService.js";
import {
  createEmptyState,
  type AppState,
} from "./appState.js";
import { SlashCommandBus } from "./slashCommandBus.js";

type Listener = (state: AppState) => void;

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
  private modelClient: ModelClient;
  private state: AppState;
  private slashBus?: SlashCommandBus;
  private exitResolver?: () => void;
  private readonly exitPromise: Promise<void>;

  private constructor(private readonly config: RuntimeConfig) {
    this.state = createEmptyState(config.cwd);
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

  public async submitInput(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    const slashResult = await this.getSlashBus().execute(trimmed);
    if (slashResult.handled) {
      if (slashResult.clearUi) {
        await this.agentManager.clearActiveAgentUi();
      }
      if (slashResult.messages.length > 0) {
        await this.agentManager.appendUiMessagesToActiveAgent(
          slashResult.messages,
        );
      }
      if (slashResult.exitRequested) {
        await this.requestExit();
      }
      return;
    }

    void this.agentManager.submitInputToActiveAgent(trimmed);
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

    this.slashBus = new SlashCommandBus({
      getSessionId: () => this.state.sessionId,
      getActiveHeadId: () => this.state.activeWorkingHeadId,
      getActiveAgentId: () => this.state.activeAgentId,
      getShellCwd: () => this.state.shellCwd,
      getHookStatus: () => this.agentManager.getHookStatus(),
      getApprovalMode: () => this.approvalPolicy.getMode(),
      getModelStatus: () => this.getModelStatus(),
      getStatusLine: () =>
        `status=${this.state.status.mode} | detail=${this.state.status.detail} | agent=${this.state.activeWorkingHeadName ?? "N/A"} | session=${this.state.sessionId} | ref=${this.state.sessionRef?.label ?? "N/A"} | shell=${this.state.shellCwd}`,
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
      getAgentStatus: async (agentId) => this.agentManager.getAgentStatus(agentId),
      listAgents: async () => this.agentManager.listAgents(),
      spawnAgent: async (name, kind) => {
        return kind === "task"
          ? this.agentManager.spawnTaskAgent({ name })
          : this.agentManager.spawnInteractiveAgent({ name });
      },
      switchAgent: async (agentId) => this.agentManager.switchAgent(agentId),
      switchAgentRelative: async (offset) => this.agentManager.switchAgentRelative(offset),
      closeAgent: async (agentId) => this.agentManager.closeAgent(agentId),
      interruptAgent: async () => this.agentManager.interruptAgent(),
      resumeAgent: async () => this.agentManager.resumeAgent(),
      getSessionGraphStatus: async () =>
        this.agentManager.getSessionGraphStatus(),
      listSessionRefs: async () => this.agentManager.listSessionRefs(),
      listSessionHeads: async () => this.agentManager.listSessionHeads(),
      listSessionLog: async (limit) => this.agentManager.listSessionLog(limit),
      compactSession: async () => this.agentManager.compactSession(),
      createSessionBranch: async (name) =>
        this.agentManager.createSessionBranch(name),
      forkSessionBranch: async (name) =>
        this.agentManager.forkSessionBranch(name),
      checkoutSessionRef: async (ref) =>
        this.agentManager.checkoutSessionRef(ref),
      createSessionTag: async (name) =>
        this.agentManager.createSessionTag(name),
      mergeSessionRef: async (ref) =>
        this.agentManager.mergeSessionRef(ref),
      forkSessionHead: async (name) =>
        this.agentManager.forkSessionHead(name),
      switchSessionHead: async (headId) =>
        this.agentManager.switchSessionHead(headId),
      attachSessionHead: async (headId, ref) =>
        this.agentManager.attachSessionHead(headId, ref),
      detachSessionHead: async (headId) =>
        this.agentManager.detachSessionHead(headId),
      mergeSessionHead: async (sourceHeadId) =>
        this.agentManager.mergeSessionHead(sourceHeadId),
      closeSessionHead: async (headId) =>
        this.agentManager.closeSessionHead(headId),
    });

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

    this.state = {
      activeAgentId: activeView.id,
      activeAgentKind: activeView.kind,
      activeWorkingHeadId: activeRuntime.headId,
      activeWorkingHeadName: activeView.name,
      sessionId: activeRuntime.sessionId,
      cwd: activeRuntime.getSnapshot().cwd,
      shellCwd: activeView.shellCwd,
      approvalMode: this.approvalPolicy.getMode(),
      status: {
        mode: activeView.status,
        detail: activeView.detail,
        updatedAt: new Date().toISOString(),
      },
      uiMessages: [
        ...(infoMessage
          ? [
              {
                id: createId("ui"),
                role: "info" as const,
                content: infoMessage,
                createdAt: new Date().toISOString(),
              },
            ]
          : []),
        ...activeRuntime.getSnapshot().uiMessages,
      ],
      draftAssistantText: activeRuntime.getDraftAssistantText(),
      modelMessages: activeRuntime.getSnapshot().modelMessages,
      availableSkills: this.skillRegistry.getAll(),
      sessionRef: activeRuntime.getRef(),
      sessionHead: activeRuntime.getHead(),
      pendingApproval: activeRuntime.getPendingApproval(),
      pendingApprovals,
      agents: this.agentManager.listAgents(),
      shouldExit: this.state.shouldExit,
      lastUserPrompt: activeRuntime.getSnapshot().lastUserPrompt,
      currentTokenEstimate: estimateMessagesTokens(
        activeRuntime.getSnapshot().modelMessages,
      ),
      autoCompactThresholdTokens: this.config.runtime.autoCompactThresholdTokens,
    };
    this.events.emit("state", this.state);
  }
}

export async function createAppController(
  cliOptions: CliOptions,
): Promise<AppController> {
  return AppController.create(cliOptions);
}
