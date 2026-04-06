import { EventEmitter } from "node:events";

import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  CliOptions,
  LlmMessage,
  MemoryRecord,
  ModelClient,
  ModelProvider,
  RuntimeConfig,
  SkillManifest,
  UIMessage,
} from "../types.js";
import {
  defaultBaseUrlForProvider,
  loadRuntimeConfig,
  persistGlobalModelConfig,
  persistProjectModelConfig,
} from "../config/index.js";
import { PromptAssembler } from "../context/index.js";
import { MemoryService } from "../memory/index.js";
import { createModelClient } from "../model/index.js";
import { SessionService } from "../session/index.js";
import { SkillRegistry } from "../skills/index.js";
import {
  ApprovalPolicy,
  PersistentShellSession,
  ShellTool,
  ToolRegistry,
  formatToolResultForModel,
} from "../tool/index.js";
import { createId, firstLine, formatDuration } from "../utils/index.js";
import { AgentRunner } from "./agentRunner.js";
import {
  createEmptyState,
  reduceAppEvent,
  toSessionSnapshot,
  type AppEvent,
  type AppState,
} from "./appState.js";
import { SlashCommandBus } from "./slashCommandBus.js";

type Listener = (state: AppState) => void;

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

export class AppController {
  public static async create(cliOptions: CliOptions): Promise<AppController> {
    const config = await loadRuntimeConfig(cliOptions);
    const controller = new AppController(config);
    await controller.initialize();
    return controller;
  }

  private readonly events = new EventEmitter();
  private readonly sessionService: SessionService;
  private readonly memoryService: MemoryService;
  private readonly skillRegistry: SkillRegistry;
  private readonly approvalPolicy: ApprovalPolicy;
  private modelClient: ModelClient;
  private readonly promptAssembler = new PromptAssembler();

  private state: AppState;
  private shellTool?: ShellTool;
  private toolRegistry?: ToolRegistry;
  private agentRunner?: AgentRunner;
  private slashBus?: SlashCommandBus;
  private pendingApproval?: PendingApproval;
  private exitResolver?: () => void;
  private readonly exitPromise: Promise<void>;

  private constructor(private readonly config: RuntimeConfig) {
    this.state = createEmptyState(config.cwd);
    this.sessionService = new SessionService(config.resolvedPaths.sessionRoot);
    this.memoryService = new MemoryService(config.resolvedPaths);
    this.skillRegistry = new SkillRegistry(config.resolvedPaths);
    this.approvalPolicy = new ApprovalPolicy(config.tool.approvalMode);
    this.modelClient = createModelClient(config.model);
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
        await this.dispatch({ type: "ui.cleared" });
      }
      for (const msg of slashResult.messages) {
        await this.addUiMessage(msg);
      }
      if (slashResult.exitRequested) {
        await this.requestExit();
      }
      return;
    }

    if (this.getRunner().isRunning()) {
      await this.addUiMessage({
        id: createId("ui"),
        role: "error",
        content: "Agent 正在执行中。可先使用 /agent interrupt 中断，再提交新任务。",
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const autoBranch = await this.sessionService.prepareForUserInput(
      this.getCurrentSessionSnapshot(),
    );
    if (autoBranch) {
      await this.dispatch(
        {
          type: "session.ref.updated",
          ref: autoBranch.ref,
        },
        false,
      );
      await this.addUiMessage({
        id: createId("ui"),
        role: "info",
        content: autoBranch.message,
        createdAt: new Date().toISOString(),
      });
    }

    const now = new Date().toISOString();
    const uiMessage: UIMessage = {
      id: createId("ui"),
      role: "user",
      content: trimmed,
      createdAt: now,
    };
    const modelMessage: LlmMessage = {
      id: createId("llm"),
      role: "user",
      content: trimmed,
      createdAt: now,
    };
    await this.dispatch({ type: "ui.message.add", message: uiMessage });
    await this.dispatch({ type: "model.message.add", message: modelMessage });
    await this.dispatch({ type: "last_user_prompt.set", prompt: trimmed });

    void this.getRunner().runLoop();
  }

  public async approvePendingRequest(approved: boolean): Promise<void> {
    if (!this.pendingApproval) {
      return;
    }

    const pending = this.pendingApproval;
    this.pendingApproval = undefined;
    await this.dispatch({ type: "approval.resolved" });
    await this.dispatch(
      {
        type: "status.set",
        mode: approved ? "running" : "interrupted",
        detail: approved ? "审批已通过，继续执行" : "审批已拒绝",
      },
      false,
    );
    pending.resolve({
      requestId: pending.request.id,
      approved,
      decidedAt: new Date().toISOString(),
    });
  }

  public async requestExit(): Promise<void> {
    await this.resolvePendingApproval(false);
    this.getRunner().interrupt();
    if (!this.getRunner().isRunning()) {
      await this.sessionService.flushCheckpointOnExit(this.getCurrentSessionSnapshot());
      await this.syncSessionRefState();
    }
    await this.dispatch({ type: "exit.requested" });
    this.exitResolver?.();
  }

  public async waitForExit(): Promise<void> {
    await this.exitPromise;
  }

  public async dispose(): Promise<void> {
    await this.shellTool?.dispose();
  }

  public async interruptAgent(): Promise<void> {
    await this.resolvePendingApproval(false);
    this.getRunner().interrupt();
  }

  public async resumeAgent(): Promise<void> {
    if (this.getRunner().isRunning()) {
      return;
    }
    void this.getRunner().runLoop();
  }

  public async setApprovalMode(mode: ApprovalMode): Promise<void> {
    this.approvalPolicy.setMode(mode);
    await this.dispatch({ type: "tool.approval_mode.updated", mode });
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
    this.rebuildModelRuntime();
  }

  public async setModelName(model: string): Promise<void> {
    this.assertModelConfigMutable();

    this.config.model.model = model;
    await persistProjectModelConfig(this.config.resolvedPaths, {
      model,
    });
    this.rebuildModelRuntime();
  }

  public async setModelApiKey(apiKey: string): Promise<void> {
    this.assertModelConfigMutable();

    this.config.model.apiKey = apiKey;
    await persistGlobalModelConfig(this.config.resolvedPaths, {
      apiKey,
    });
    this.rebuildModelRuntime();
  }

  private async initialize(): Promise<void> {
    const skills = await this.skillRegistry.refresh();
    const initialized = await this.sessionService.initialize({
      cwd: this.config.cwd,
      shellCwd: this.config.cwd,
      approvalMode: this.config.tool.approvalMode,
      resumeSessionId: this.config.cli.resumeSessionId,
    });
    const snapshot = initialized.snapshot;

    this.state = reduceAppEvent(this.state, {
      type: "session.loaded",
      snapshot,
    });
    this.state = reduceAppEvent(this.state, {
      type: "session.ref.updated",
      ref: initialized.ref,
    });
    this.state = reduceAppEvent(this.state, {
      type: "skills.available",
      skills,
    });
    if (initialized.infoMessage) {
      this.state = reduceAppEvent(this.state, {
        type: "ui.message.add",
        message: {
          id: createId("ui"),
          role: "info",
          content: initialized.infoMessage,
          createdAt: new Date().toISOString(),
        },
      });
    }
    this.state = reduceAppEvent(this.state, {
      type: "status.set",
      mode: "idle",
      detail: snapshot.modelMessages.length > 0 ? "会话已恢复" : "等待输入",
    });

    const shellSession = new PersistentShellSession(
      this.config.tool.shellExecutable,
      snapshot.shellCwd,
    );
    this.shellTool = new ShellTool(
      shellSession,
      this.config.runtime.maxToolOutputChars,
    );
    this.toolRegistry = new ToolRegistry(this.shellTool);
    this.agentRunner = this.createAgentRunner();
    this.slashBus = new SlashCommandBus({
      getSessionId: () => this.state.sessionId,
      getShellCwd: () => this.shellTool?.getRuntimeStatus().cwd ?? this.state.shellCwd,
      getApprovalMode: () => this.approvalPolicy.getMode(),
      getModelStatus: () => this.getModelStatus(),
      getStatusLine: () =>
        `status=${this.state.status.mode} | detail=${this.state.status.detail} | session=${this.state.sessionId} | ref=${this.state.sessionRef?.label ?? "N/A"} | shell=${this.state.shellCwd}`,
      getAvailableSkills: () => this.skillRegistry.getAll(),
      setApprovalMode: async (mode) => {
        await this.setApprovalMode(mode);
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
      listMemory: async (limit) => this.memoryService.list(limit),
      saveMemory: async (input) => this.memoryService.save(input),
      showMemory: async (id) => this.memoryService.show(id),
      interruptAgent: async () => this.interruptAgent(),
      resumeAgent: async () => this.resumeAgent(),
      getSessionGraphStatus: async () =>
        this.sessionService.getStatus(this.getCurrentSessionSnapshot()),
      listSessionRefs: async () =>
        this.sessionService.listRefs(this.getCurrentSessionSnapshot()),
      listSessionLog: async (limit) => this.sessionService.log(limit),
      createSessionBranch: async (name) => this.createSessionBranch(name),
      forkSessionBranch: async (name) => this.forkSessionBranch(name),
      checkoutSessionRef: async (ref) => this.checkoutSessionRef(ref),
      createSessionTag: async (name) => this.createSessionTag(name),
      mergeSessionRef: async (ref) => this.mergeSessionRef(ref),
    });

    this.events.emit("state", this.state);
  }

  private async addUiMessage(message: UIMessage): Promise<void> {
    await this.dispatch({ type: "ui.message.add", message });
  }

  private async requestApproval(
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    await this.dispatch({ type: "approval.requested", request }, false);
    await this.dispatch(
      {
        type: "status.set",
        mode: "awaiting-approval",
        detail: firstLine(request.summary, "等待审批"),
      },
      false,
    );

    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = {
        request,
        resolve,
      };
    });
  }

  private async resolvePendingApproval(approved: boolean): Promise<void> {
    if (!this.pendingApproval) {
      return;
    }

    await this.approvePendingRequest(approved);
  }

  private async dispatch(event: AppEvent, persist = true): Promise<void> {
    this.state = reduceAppEvent(this.state, event);
    this.events.emit("state", this.state);

    if (!persist || !this.state.sessionId) {
      return;
    }

    await this.sessionService.persistWorkingEvent({
      id: createId("event"),
      sessionId: this.state.sessionId,
      type: event.type,
      timestamp: new Date().toISOString(),
      payload: event as unknown as Record<string, unknown>,
    });
    await this.sessionService.persistWorkingSnapshot(this.getCurrentSessionSnapshot());
  }

  private getRunner(): AgentRunner {
    if (!this.agentRunner) {
      throw new Error("AgentRunner 尚未初始化");
    }
    return this.agentRunner;
  }

  private getSlashBus(): SlashCommandBus {
    if (!this.slashBus) {
      throw new Error("SlashCommandBus 尚未初始化");
    }
    return this.slashBus;
  }

  private assertModelConfigMutable(): void {
    if (this.getRunner().isRunning() || this.pendingApproval) {
      throw new Error("请先让 Agent 处于空闲状态，再修改模型配置。");
    }
  }

  private assertSessionGraphMutable(): void {
    if (this.getRunner().isRunning() || this.pendingApproval) {
      throw new Error("请先让 Agent 处于空闲状态，再修改 session 图。");
    }
  }

  private rebuildModelRuntime(): void {
    this.modelClient = createModelClient(this.config.model);
    this.agentRunner = this.createAgentRunner();
  }

  private createAgentRunner(): AgentRunner {
    if (!this.toolRegistry) {
      throw new Error("ToolRegistry 尚未初始化");
    }

    return new AgentRunner({
      config: this.config,
      promptAssembler: this.promptAssembler,
      modelClient: this.modelClient,
      toolRegistry: this.toolRegistry,
      approvalPolicy: this.approvalPolicy,
      getModelMessages: () => this.state.modelMessages,
      getAvailableSkills: () => this.skillRegistry.getAll(),
      getShellCwd: () => this.shellTool?.getRuntimeStatus().cwd ?? this.state.shellCwd,
      getLastUserPrompt: () => this.state.lastUserPrompt,
      searchRelevantMemory: (query) => this.memoryService.search(query, 5),
      commitAssistantTurn: async ({ content, toolCalls }) => {
        if (!content && toolCalls.length === 0) {
          return;
        }

        const now = new Date().toISOString();
        const modelMessage: LlmMessage = {
          id: createId("llm"),
          role: "assistant",
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          createdAt: now,
        };
        await this.dispatch({ type: "model.message.add", message: modelMessage });

        if (content.trim()) {
          await this.dispatch({
            type: "ui.message.add",
            message: {
              id: createId("ui"),
              role: "assistant",
              content,
              createdAt: now,
            },
          });
        }
      },
      commitToolResult: async (result) => {
        const content = formatToolResultForModel(result);
        const now = new Date().toISOString();
        await this.dispatch({
          type: "model.message.add",
          message: {
            id: createId("llm"),
            role: "tool",
            name: "shell",
            toolCallId: result.callId,
            content,
            createdAt: now,
          },
        });
        await this.dispatch({
          type: "ui.message.add",
          message: {
            id: createId("ui"),
            role: result.status === "success" ? "tool" : "error",
            content: [
              `$ ${result.command}`,
              `status=${result.status} exit=${result.exitCode ?? "null"} cwd=${result.cwd} duration=${formatDuration(result.durationMs)}`,
              result.stdout ? `stdout:\n${result.stdout}` : "",
              result.stderr ? `stderr:\n${result.stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            createdAt: now,
            title: "Shell Tool",
          },
        });
        await this.dispatch({ type: "tool.cwd.updated", cwd: result.cwd });
      },
      emitInfo: async (message) => {
        await this.addUiMessage({
          id: createId("ui"),
          role: "info",
          content: message,
          createdAt: new Date().toISOString(),
        });
      },
      emitError: async (message) => {
        await this.addUiMessage({
          id: createId("ui"),
          role: "error",
          content: message,
          createdAt: new Date().toISOString(),
        });
      },
      setStatus: async (mode, detail) => {
        await this.dispatch({ type: "status.set", mode, detail }, false);
        if (mode === "idle") {
          await this.sessionService.flushCheckpointIfDirty(
            this.getCurrentSessionSnapshot(),
          );
          await this.syncSessionRefState();
        }
      },
      startAssistantDraft: async () => {
        await this.dispatch({ type: "assistant.stream.start" }, false);
      },
      pushAssistantDraft: async (delta) => {
        await this.dispatch({ type: "assistant.stream.delta", delta }, false);
      },
      finishAssistantDraft: async () => {
        await this.dispatch({ type: "assistant.stream.finish" }, false);
      },
      requestApproval: async (request) => this.requestApproval(request),
    });
  }

  private getCurrentSessionSnapshot() {
    return toSessionSnapshot(this.state);
  }

  private async syncSessionRefState(): Promise<void> {
    const ref = await this.sessionService.getStatus(this.getCurrentSessionSnapshot());
    await this.dispatch({ type: "session.ref.updated", ref }, false);
  }

  private async createSessionBranch(name: string) {
    this.assertSessionGraphMutable();
    const result = await this.sessionService.createBranch(
      name,
      this.getCurrentSessionSnapshot(),
    );
    await this.dispatch({ type: "session.ref.updated", ref: result.ref }, false);
    return result.ref;
  }

  private async forkSessionBranch(name: string) {
    this.assertSessionGraphMutable();
    const result = await this.sessionService.forkBranch(
      name,
      this.getCurrentSessionSnapshot(),
    );
    await this.dispatch({ type: "session.ref.updated", ref: result.ref }, false);
    return result.ref;
  }

  private async checkoutSessionRef(ref: string) {
    this.assertSessionGraphMutable();
    const result = await this.sessionService.checkout(
      ref,
      this.getCurrentSessionSnapshot(),
    );
    await this.dispatch({ type: "session.loaded", snapshot: result.snapshot }, false);
    await this.dispatch({ type: "session.ref.updated", ref: result.ref }, false);
    return result;
  }

  private async createSessionTag(name: string) {
    this.assertSessionGraphMutable();
    const result = await this.sessionService.createTag(
      name,
      this.getCurrentSessionSnapshot(),
    );
    await this.dispatch({ type: "session.ref.updated", ref: result.ref }, false);
    return result.ref;
  }

  private async mergeSessionRef(ref: string) {
    this.assertSessionGraphMutable();
    const result = await this.sessionService.merge(
      ref,
      this.getCurrentSessionSnapshot(),
    );
    await this.dispatch({ type: "session.ref.updated", ref: result.ref }, false);
    return result.ref;
  }
}

export async function createAppController(
  cliOptions: CliOptions,
): Promise<AppController> {
  return AppController.create(cliOptions);
}
