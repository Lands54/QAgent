import type {
  ApprovalMode,
  LlmMessage,
  PromptProfile,
  SessionSnapshot,
  SessionWorkingHead,
  ToolMode,
  UIMessage,
} from "../../types.js";

interface HelperAgentRuntimeLike {
  getHead(): SessionWorkingHead;
  getSnapshot(): SessionSnapshot;
}

export interface HelperTaskSpec<TResult> {
  name: string;
  sourceAgentId?: string;
  activate?: boolean;
  approvalMode?: ApprovalMode;
  promptProfile?: PromptProfile;
  toolMode?: ToolMode;
  autoMemoryFork?: boolean;
  retainOnCompletion?: boolean;
  mergeIntoAgentId?: string;
  mergeAssets?: string[];
  seedModelMessages?: LlmMessage[];
  seedUiMessages?: UIMessage[];
  lastUserPrompt?: string;
  buildRuntimeOverrides?: (head: SessionWorkingHead) => {
    promptProfile?: PromptProfile;
    toolMode?: ToolMode;
    systemPrompt?: string;
    maxAgentSteps?: number;
    environment?: Record<string, string>;
  };
  buildPrompt?: (runtime: HelperAgentRuntimeLike) => Promise<string> | string;
  submitOptions?: {
    activate?: boolean;
    skipFetchMemoryHook?: boolean;
  };
  readResult: (runtime: HelperAgentRuntimeLike) => Promise<TResult> | TResult;
}

export interface HelperAgentCoordinatorDependencies {
  spawnTaskAgent(input: {
    name: string;
    sourceAgentId?: string;
    activate?: boolean;
    approvalMode?: ApprovalMode;
    promptProfile?: PromptProfile;
    toolMode?: ToolMode;
    autoMemoryFork?: boolean;
    retainOnCompletion?: boolean;
    uiContextEnabled?: boolean;
    mergeIntoAgentId?: string;
    mergeAssets?: string[];
    seedModelMessages?: LlmMessage[];
    seedUiMessages?: UIMessage[];
    lastUserPrompt?: string;
    buildRuntimeOverrides?: (head: SessionWorkingHead) => {
      promptProfile?: PromptProfile;
      toolMode?: ToolMode;
      systemPrompt?: string;
      maxAgentSteps?: number;
      environment?: Record<string, string>;
    };
  }): Promise<{ id: string }>;
  submitInputToAgent(
    agentId: string,
    input: string,
    options?: {
      activate?: boolean;
      skipFetchMemoryHook?: boolean;
    },
  ): Promise<void>;
  getRuntime(agentId: string): HelperAgentRuntimeLike;
  cleanupCompletedAgent(agentId: string): Promise<void>;
  shouldAutoCleanupHelperAgent(): boolean;
}

export class HelperAgentCoordinator {
  public constructor(
    private readonly deps: HelperAgentCoordinatorDependencies,
  ) {}

  public async run<TResult>(
    spec: HelperTaskSpec<TResult>,
  ): Promise<{ agentId: string; result: TResult }> {
    const helper = await this.deps.spawnTaskAgent({
      name: spec.name,
      sourceAgentId: spec.sourceAgentId,
      activate: spec.activate,
      approvalMode: spec.approvalMode,
      promptProfile: spec.promptProfile,
      toolMode: spec.toolMode,
      autoMemoryFork: spec.autoMemoryFork,
      retainOnCompletion: spec.retainOnCompletion,
      uiContextEnabled: false,
      mergeIntoAgentId: spec.mergeIntoAgentId,
      mergeAssets: spec.mergeAssets,
      seedModelMessages: spec.seedModelMessages,
      seedUiMessages: spec.seedUiMessages,
      lastUserPrompt: spec.lastUserPrompt,
      buildRuntimeOverrides: spec.buildRuntimeOverrides,
    });

    try {
      const runtime = this.deps.getRuntime(helper.id);
      const prompt = spec.buildPrompt ? await spec.buildPrompt(runtime) : undefined;
      if (prompt) {
        await this.deps.submitInputToAgent(helper.id, prompt, spec.submitOptions);
      }
      const result = await spec.readResult(this.deps.getRuntime(helper.id));
      return {
        agentId: helper.id,
        result,
      };
    } finally {
      if (
        spec.retainOnCompletion === false
        && this.deps.shouldAutoCleanupHelperAgent()
      ) {
        await this.deps.cleanupCompletedAgent(helper.id);
      }
    }
  }
}
