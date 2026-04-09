import type { SessionService } from "../../session/index.js";
import type { AgentViewState } from "../../types.js";
import type { AgentRuntimeCallbacks } from "../agentRuntime.js";
import type { AgentRuntimeFactory } from "../agentRuntimeFactory.js";
import type { AgentRegistry } from "./agentRegistry.js";

interface AgentNavigationInput {
  registry: AgentRegistry;
  sessionService: SessionService;
  runtimeFactory: AgentRuntimeFactory;
  createRuntimeCallbacks: () => AgentRuntimeCallbacks;
  emitChange: () => void;
}

export class AgentNavigationService {
  public constructor(private readonly input: AgentNavigationInput) {}

  public resolveExecutorId(identifier: string): string {
    if (this.input.registry.getEntry(identifier)) {
      return identifier;
    }

    const matched = this.input.registry
      .listAgentViews()
      .filter((agent) => agent.status !== "closed" && agent.name === identifier);
    if (matched.length === 1) {
      return matched[0]!.id;
    }
    if (matched.length > 1) {
      throw new Error(`存在多个同名 agent：${identifier}，请改用 agent id。`);
    }
    throw new Error(`未找到 agent：${identifier}`);
  }

  public resolveWorklineId(identifier: string): string {
    const directRuntime = this.input.registry.getEntry(identifier)?.runtime;
    if (directRuntime) {
      return directRuntime.headId;
    }

    const matched = this.input.registry
      .listAgentViews()
      .filter((agent) => {
        return agent.status !== "closed"
          && !agent.helperType
          && (agent.headId === identifier || agent.name === identifier);
      });
    const uniqueHeadIds = [...new Set(matched.map((agent) => agent.headId))];
    if (uniqueHeadIds.length === 1) {
      return uniqueHeadIds[0]!;
    }
    if (uniqueHeadIds.length > 1) {
      throw new Error(`存在多个同名 working head：${identifier}，请改用 workline id。`);
    }
    throw new Error(`未找到 working head：${identifier}`);
  }

  public async switchExecutor(executorId: string): Promise<AgentViewState> {
    const resolvedExecutorId = this.resolveExecutorId(executorId);
    const runtime = this.input.registry.requireRuntime(resolvedExecutorId);
    return this.switchWorkline(runtime.headId, resolvedExecutorId);
  }

  public async switchWorkline(
    worklineId: string,
    currentExecutorId = this.input.registry.getActiveAgentId(),
  ): Promise<AgentViewState> {
    const resolvedHeadId = this.resolveWorklineId(worklineId);
    const current = this.input.registry.requireRuntime(currentExecutorId);
    if (resolvedHeadId === current.headId) {
      this.input.registry.setActiveAgentId(current.agentId);
      return current.getViewState();
    }

    const result = await this.input.sessionService.switchHead(
      resolvedHeadId,
      current.getSnapshot(),
    );
    let runtime = this.input.registry.getEntryByHeadId(resolvedHeadId)?.runtime;
    if (!runtime) {
      runtime = await this.input.runtimeFactory.createFromSessionState(
        result.head,
        result.snapshot,
        this.input.createRuntimeCallbacks(),
        result.ref,
      );
      this.input.registry.set(runtime.agentId, {
        runtime,
      });
    } else {
      await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    }
    this.input.registry.setActiveAgentId(runtime.agentId);
    this.input.emitChange();
    return runtime.getViewState();
  }

  public async switchWorklineRelative(offset: number): Promise<AgentViewState> {
    const worklines = this.getNavigableWorklines();
    if (worklines.length === 0) {
      throw new Error("当前没有可切换的工作线。");
    }
    const currentHeadId = this.input.registry.getActiveRuntime().headId;
    const currentIndex = worklines.findIndex((workline) => {
      return workline.id === currentHeadId;
    });
    if (currentIndex < 0) {
      return this.switchWorkline(worklines[0]!.id);
    }
    const nextIndex = (currentIndex + offset + worklines.length) % worklines.length;
    return this.switchWorkline(worklines[nextIndex]!.id);
  }

  public async switchAgent(agentId: string): Promise<AgentViewState> {
    return this.switchExecutor(agentId);
  }

  public async switchAgentRelative(offset: number): Promise<AgentViewState> {
    return this.switchWorklineRelative(offset);
  }

  public getNavigableAgents(): AgentViewState[] {
    return this.input.registry
      .listAgentViews()
      .filter((agent) => agent.status !== "closed")
      .sort((left, right) => {
        const helperDiff =
          Number(Boolean(left.helperType)) - Number(Boolean(right.helperType));
        if (helperDiff !== 0) {
          return helperDiff;
        }
        return left.name.localeCompare(right.name);
      });
  }

  public getNavigableWorklines(): Array<{
    id: string;
    name: string;
  }> {
    return [...new Map(
      this.getNavigableAgents()
        .filter((agent) => !agent.helperType)
        .map((agent) => [agent.headId, { id: agent.headId, name: agent.name }]),
    ).values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  public pickFallbackAgentId(
    currentAgentId: string,
    preferredAgentIds: Array<string | undefined>,
  ): string | undefined {
    const candidates = [
      ...preferredAgentIds,
      ...this.getNavigableAgents()
        .map((agent) => agent.id)
        .filter((id) => id !== currentAgentId),
    ].filter((id): id is string => Boolean(id));

    return candidates.find((id) => {
      const entry = this.input.registry.getEntry(id);
      if (!entry) {
        return false;
      }
      return entry.runtime.getViewState().status !== "closed";
    });
  }
}
