import { createHash } from "node:crypto";

import type {
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

  public async handleRuntimeCompleted(runtime: HeadAgentRuntime): Promise<void> {
    if (
      this.input.getSaveMemoryHookEnabled()
      && runtime.kind === "interactive"
      && runtime.autoMemoryFork
    ) {
      await this.runAutoMemoryForkIfNeeded(runtime.agentId);
    }
  }

  private async runAutoMemoryForkIfNeeded(agentId: string): Promise<void> {
    const runtime = this.input.coordinator.getRuntime(agentId);
    const snapshot = runtime.getSnapshot();
    const sourceHash = computeAutoMemoryForkSourceHash(snapshot);
    if (
      !sourceHash
      || sourceHash === this.input.lastAutoMemoryForkSourceHashByAgent.get(agentId)
    ) {
      return;
    }

    const service = new AutoMemoryForkService(this.input.coordinator);
    try {
      await service.run({
        sourceAgentId: agentId,
        targetAgentId: agentId,
        targetSnapshot: snapshot,
        availableSkills: this.input.getAvailableSkills(),
        lastUserPrompt: snapshot.lastUserPrompt,
        modelMessages: snapshot.modelMessages,
      });
      this.input.lastAutoMemoryForkSourceHashByAgent.set(agentId, sourceHash);
      await runtime.refreshSessionState();
    } catch (error) {
      await runtime.appendUiMessages([
        {
          id: createId("ui"),
          role: "error",
          content: `自动 memory fork 失败：${(error as Error).message}`,
          createdAt: new Date().toISOString(),
        },
      ]);
    }
    this.input.emitChange();
  }
}
