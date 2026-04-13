import { createHash } from "node:crypto";

import type {
  LlmMessage,
  RuntimeConfig,
  SessionSnapshot,
  SkillManifest,
} from "../../types.js";
import { createId } from "../../utils/index.js";
import type { HeadAgentRuntime } from "../agentRuntime.js";
import { AutoMemoryForkService } from "../autoMemoryForkService.js";
import { CompactSessionService } from "../compactSessionService.js";
import { FetchMemoryService } from "../fetchMemoryService.js";
import type { SpawnAgentOptions } from "./agentLifecycleService.js";

function computeAutoMemoryForkSourceHash(
  snapshot: SessionSnapshot,
): string | undefined {
  if (!snapshot.lastUserPrompt || snapshot.modelMessages.length === 0) {
    return undefined;
  }

  return createHash("sha1")
    .update(
      JSON.stringify({
        lastUserPrompt: snapshot.lastUserPrompt,
        modelMessages: snapshot.modelMessages.map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.role === "tool" ? message.toolCallId : undefined,
        })),
      }),
    )
    .digest("hex");
}

export interface PostRunAutoMemoryForkJob {
  kind: "auto-memory-fork";
  agentId: string;
  sourceHash: string;
  lastUserPrompt?: string;
  modelMessages: ReadonlyArray<LlmMessage>;
}

export type PostRunJob = PostRunAutoMemoryForkJob;

interface HookPipelineCoordinator {
  getRuntime(agentId: string): HeadAgentRuntime;
  getBaseSystemPrompt(): string | undefined;
  getRuntimeConfig(): RuntimeConfig;
  spawnTaskAgent(options: SpawnAgentOptions): Promise<{ id: string }>;
  submitInputToAgent(
    agentId: string,
    input: string,
    options?: {
      activate?: boolean;
      skipFetchMemoryHook?: boolean;
    },
  ): Promise<void>;
  cleanupCompletedAgent(agentId: string): Promise<void>;
  shouldAutoCleanupHelperAgent(): boolean;
}

interface HookPipelineInput {
  config: RuntimeConfig;
  coordinator: HookPipelineCoordinator;
  getAvailableSkills: () => SkillManifest[];
  getFetchMemoryHookEnabled: () => boolean;
  getSaveMemoryHookEnabled: () => boolean;
  getAutoCompactHookEnabled: () => boolean;
  autoCompactFailureCountByAgent: Map<string, number>;
  lastAutoMemoryForkSourceHashByAgent: Map<string, string>;
  emitChange: () => void;
}

export class HookPipeline {
  public constructor(private readonly input: HookPipelineInput) {}

  public async buildModelInputAppendix(
    runtime: HeadAgentRuntime,
    userPrompt: string,
    skipFetchMemoryHook?: boolean,
  ): Promise<string | undefined> {
    if (
      skipFetchMemoryHook
      || !this.input.getFetchMemoryHookEnabled()
      || runtime.promptProfile !== "default"
    ) {
      return undefined;
    }
    return new FetchMemoryService(this.input.coordinator).run({
      sourceAgentId: runtime.agentId,
      userPrompt,
    });
  }

  public async handleBeforeModelTurn(runtime: HeadAgentRuntime): Promise<void> {
    if (!this.input.getAutoCompactHookEnabled() || runtime.promptProfile !== "default") {
      return;
    }
    const failureCount =
      this.input.autoCompactFailureCountByAgent.get(runtime.agentId) ?? 0;
    if (failureCount >= 3) {
      return;
    }
    try {
      const result = await new CompactSessionService(
        this.input.coordinator,
        this.input.config,
      ).run({
        targetAgentId: runtime.agentId,
        reason: "auto",
        force: false,
      });
      if (result.compacted) {
        this.input.autoCompactFailureCountByAgent.delete(runtime.agentId);
        await runtime.refreshSessionState();
        this.input.emitChange();
      }
    } catch (error) {
      this.input.autoCompactFailureCountByAgent.set(
        runtime.agentId,
        failureCount + 1,
      );
      await runtime.appendUiMessages([
        {
          id: createId("ui"),
          role: "error",
          content: `自动 compact 失败：${(error as Error).message}`,
          createdAt: new Date().toISOString(),
        },
      ]);
      this.input.emitChange();
    }
  }

  public collectPostRunJobs(runtime: HeadAgentRuntime): PostRunJob[] {
    if (
      !this.input.getSaveMemoryHookEnabled()
      || runtime.kind !== "interactive"
      || !runtime.autoMemoryFork
    ) {
      return [];
    }

    const snapshot = runtime.getSnapshot();
    const sourceHash = computeAutoMemoryForkSourceHash(snapshot);
    if (
      !sourceHash
      || sourceHash === this.input.lastAutoMemoryForkSourceHashByAgent.get(runtime.agentId)
    ) {
      return [];
    }

    return [{
      kind: "auto-memory-fork",
      agentId: runtime.agentId,
      sourceHash,
      lastUserPrompt: snapshot.lastUserPrompt,
      modelMessages: [...snapshot.modelMessages],
    }];
  }

  public async runPostRunJob(job: PostRunJob): Promise<void> {
    if (job.kind === "auto-memory-fork") {
      await this.runAutoMemoryForkJob(job);
    }
  }

  private async runAutoMemoryForkJob(job: PostRunAutoMemoryForkJob): Promise<void> {
    const runtime = this.input.coordinator.getRuntime(job.agentId);
    const service = new AutoMemoryForkService(this.input.coordinator);
    await service.run({
      sourceAgentId: job.agentId,
      targetAgentId: job.agentId,
      targetSnapshot: runtime.getSnapshot(),
      availableSkills: this.input.getAvailableSkills(),
      lastUserPrompt: job.lastUserPrompt,
      modelMessages: job.modelMessages,
    });
    this.input.lastAutoMemoryForkSourceHashByAgent.set(
      job.agentId,
      job.sourceHash,
    );
    await runtime.refreshSessionState();
    this.input.emitChange();
  }
}
