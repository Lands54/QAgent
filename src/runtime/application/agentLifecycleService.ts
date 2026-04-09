import type { SessionService } from "../../session/index.js";
import type {
  AgentKind,
  AgentViewState,
  LlmMessage,
  PromptProfile,
  SessionWorkingHead,
  ToolMode,
  UIMessage,
} from "../../types.js";
import type { AgentRuntimeCallbacks } from "../agentRuntime.js";
import type { AgentRuntimeFactory } from "../agentRuntimeFactory.js";
import type { AgentNavigationService } from "./agentNavigationService.js";
import type { AgentRegistry } from "./agentRegistry.js";

export interface SpawnAgentOptions {
  name: string;
  sourceAgentId?: string;
  activate?: boolean;
  approvalMode?: "always" | "risky" | "never";
  promptProfile?: PromptProfile;
  toolMode?: ToolMode;
  seedModelMessages?: LlmMessage[];
  seedUiMessages?: UIMessage[];
  lastUserPrompt?: string;
  systemPrompt?: string;
  maxAgentSteps?: number;
  environment?: Record<string, string>;
  mergeIntoAgentId?: string;
  mergeAssets?: string[];
  autoMemoryFork?: boolean;
  retainOnCompletion?: boolean;
  uiContextEnabled?: boolean;
  buildRuntimeOverrides?: (head: SessionWorkingHead) => {
    promptProfile?: PromptProfile;
    toolMode?: ToolMode;
    systemPrompt?: string;
    maxAgentSteps?: number;
    environment?: Record<string, string>;
  };
}

interface AgentLifecycleInput {
  registry: AgentRegistry;
  navigation: AgentNavigationService;
  sessionService: SessionService;
  runtimeFactory: AgentRuntimeFactory;
  createRuntimeCallbacks: () => AgentRuntimeCallbacks;
  emitChange: () => void;
  lastAutoMemoryForkSourceHashByAgent: Map<string, string>;
  autoCompactFailureCountByAgent: Map<string, number>;
}

export class AgentLifecycleService {
  public constructor(private readonly input: AgentLifecycleInput) {}

  public async spawnAgent(
    kind: AgentKind,
    options: SpawnAgentOptions,
  ): Promise<AgentViewState> {
    const sourceAgentId =
      options.sourceAgentId ?? this.input.registry.getActiveAgentId();
    const sourceRuntime =
      this.input.registry.getEntry(sourceAgentId)?.runtime
      ?? this.input.registry.getEntryByHeadId(sourceAgentId)?.runtime;
    if (!sourceRuntime) {
      throw new Error(`未找到 agent：${sourceAgentId}`);
    }
    const mergeIntoAgentId = options.mergeIntoAgentId
      ? this.input.registry.getEntry(options.mergeIntoAgentId)?.runtime.agentId
        ?? this.input.registry.getEntryByHeadId(options.mergeIntoAgentId)?.runtime.agentId
        ?? options.mergeIntoAgentId
      : undefined;
    const result = await this.input.sessionService.forkHead(options.name, {
      sourceHeadId: sourceRuntime.headId,
      activate: options.activate ?? false,
      runtimeState: {
        agentKind: kind,
        autoMemoryFork: options.autoMemoryFork ?? (kind === "interactive"),
        retainOnCompletion: options.retainOnCompletion ?? true,
        uiContextEnabled: options.uiContextEnabled,
      },
    });
    const runtimeOverrides = options.buildRuntimeOverrides?.(result.head);
    const runtime = await this.input.runtimeFactory.createRuntime({
      head: result.head,
      snapshot: result.snapshot,
      initialRef: result.ref,
      policy: {
        kind,
        autoMemoryFork: options.autoMemoryFork ?? (kind === "interactive"),
        retainOnCompletion: options.retainOnCompletion ?? true,
        promptProfile: runtimeOverrides?.promptProfile ?? options.promptProfile,
        toolMode: runtimeOverrides?.toolMode ?? options.toolMode,
        approvalMode: options.approvalMode,
        systemPrompt: runtimeOverrides?.systemPrompt ?? options.systemPrompt,
        maxAgentSteps: runtimeOverrides?.maxAgentSteps ?? options.maxAgentSteps,
        environment: runtimeOverrides?.environment ?? options.environment,
      },
      callbacks: this.input.createRuntimeCallbacks(),
    });
    if (
      options.seedModelMessages
      || options.seedUiMessages
      || options.lastUserPrompt !== undefined
    ) {
      await runtime.seedConversation({
        modelMessages: options.seedModelMessages,
        uiMessages: options.seedUiMessages,
        lastUserPrompt: options.lastUserPrompt,
      });
    }

    this.input.registry.set(runtime.agentId, {
      runtime,
      sourceAgentId,
      mergeIntoAgentId,
      mergeAssets: options.mergeAssets,
      mergePending: Boolean(mergeIntoAgentId),
    });
    await this.input.sessionService.updateHeadRuntimeState(result.head.id, {
      agentKind: kind,
      autoMemoryFork: options.autoMemoryFork ?? (kind === "interactive"),
      retainOnCompletion: options.retainOnCompletion ?? true,
      promptProfile: runtimeOverrides?.promptProfile ?? options.promptProfile,
      toolMode: runtimeOverrides?.toolMode ?? options.toolMode ?? "shell",
      uiContextEnabled: options.uiContextEnabled,
    });
    if (options.activate) {
      this.input.registry.setActiveAgentId(runtime.agentId);
    }
    this.input.emitChange();
    return runtime.getViewState();
  }

  public async closeAgent(agentId: string): Promise<AgentViewState> {
    const resolvedAgentId = this.input.navigation.resolveExecutorId(agentId);
    const runtime = this.input.registry.requireRuntime(resolvedAgentId);
    if (resolvedAgentId === this.input.registry.getActiveAgentId()) {
      throw new Error("当前 active agent 不能直接关闭。");
    }
    if (runtime.isRunning()) {
      throw new Error("运行中的 agent 不能直接关闭，请先中断。");
    }
    await this.input.sessionService.closeHead(runtime.headId);
    await runtime.markClosed();
    await runtime.dispose();
    this.input.registry.delete(resolvedAgentId);
    this.input.emitChange();
    return runtime.getViewState();
  }

  public async cleanupCompletedAgent(agentId: string): Promise<void> {
    const resolvedAgentId = this.input.navigation.resolveExecutorId(agentId);
    const entry = this.input.registry.getEntry(resolvedAgentId);
    if (!entry) {
      return;
    }
    const runtime = entry.runtime;
    if (runtime.isRunning()) {
      return;
    }

    if (this.input.registry.getActiveAgentId() === resolvedAgentId) {
      const fallbackAgentId = this.input.navigation.pickFallbackAgentId(
        resolvedAgentId,
        [entry.mergeIntoAgentId, entry.sourceAgentId],
      );
      if (!fallbackAgentId) {
        return;
      }
      await this.input.navigation.switchAgent(fallbackAgentId);
    }

    await this.input.sessionService.closeHead(runtime.headId);
    await runtime.markClosed();
    await runtime.dispose();
    this.input.registry.delete(resolvedAgentId);
    this.input.lastAutoMemoryForkSourceHashByAgent.delete(resolvedAgentId);
    this.input.autoCompactFailureCountByAgent.delete(resolvedAgentId);
    this.input.emitChange();
  }

  public async disposeAll(): Promise<void> {
    await Promise.all(
      this.input.registry.getEntries().map(async (entry) => {
        await entry.runtime.dispose();
      }),
    );
  }

  public async flushCheckpointsOnExit(): Promise<void> {
    for (const entry of this.input.registry.getEntries()) {
      await this.input.sessionService.flushCheckpointOnExit(
        entry.runtime.getSnapshot(),
      );
    }
  }
}
