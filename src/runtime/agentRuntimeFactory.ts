import type {
  ModelClient,
  RuntimeConfig,
  SessionRefInfo,
  SessionSnapshot,
  SessionWorkingHead,
  SkillManifest,
} from "../types.js";
import { PromptAssembler } from "../context/index.js";
import { SessionService } from "../session/index.js";
import { ApprovalPolicy } from "../tool/index.js";
import {
  type AgentRuntimeCallbacks,
  HeadAgentRuntime,
  type HeadAgentRuntimeOptions,
} from "./agentRuntime.js";

export class AgentRuntimeFactory {
  public constructor(
    private config: RuntimeConfig,
    private modelClient: ModelClient,
    private readonly promptAssembler: PromptAssembler,
    private readonly sessionService: SessionService,
    private readonly approvalPolicy: ApprovalPolicy,
    private readonly getAvailableSkills: () => SkillManifest[],
  ) {}

  public updateSharedDependencies(
    config: RuntimeConfig,
    modelClient: ModelClient,
  ): void {
    this.config = config;
    this.modelClient = modelClient;
  }

  public async createRuntime(
    input: Omit<
      HeadAgentRuntimeOptions,
      | "config"
      | "modelClient"
      | "promptAssembler"
      | "sessionService"
      | "approvalPolicy"
      | "getAvailableSkills"
    > & {
      initialRef?: SessionRefInfo;
    },
  ): Promise<HeadAgentRuntime> {
    const runtime = new HeadAgentRuntime({
      config: this.config,
      head: input.head,
      snapshot: input.snapshot,
      sessionService: this.sessionService,
      promptAssembler: this.promptAssembler,
      modelClient: this.modelClient,
      approvalPolicy: this.approvalPolicy,
      getAvailableSkills: this.getAvailableSkills,
      policy: input.policy,
      callbacks: input.callbacks,
    });

    await runtime.initialize(input.initialRef);
    return runtime;
  }

  public async refreshRuntime(
    runtime: HeadAgentRuntime,
    config = this.config,
    modelClient = this.modelClient,
  ): Promise<void> {
    await runtime.updateModelRuntime(config, modelClient);
  }

  public async createFromSessionState(
    head: SessionWorkingHead,
    snapshot: SessionSnapshot,
    callbacks: AgentRuntimeCallbacks,
    initialRef?: SessionRefInfo,
  ): Promise<HeadAgentRuntime> {
    const runtime = new HeadAgentRuntime({
      config: this.config,
      head,
      snapshot,
      sessionService: this.sessionService,
      promptAssembler: this.promptAssembler,
      modelClient: this.modelClient,
      approvalPolicy: this.approvalPolicy,
      getAvailableSkills: this.getAvailableSkills,
      policy: {
        kind: head.runtimeState.agentKind ?? "interactive",
        autoMemoryFork: head.runtimeState.autoMemoryFork ?? true,
        retainOnCompletion: head.runtimeState.retainOnCompletion ?? true,
        promptProfile: head.runtimeState.promptProfile ?? "default",
        toolMode: head.runtimeState.toolMode ?? "shell",
      },
      callbacks,
    });
    await runtime.initialize(initialRef);
    return runtime;
  }
}
