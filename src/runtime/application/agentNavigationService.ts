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

  public resolveAgentId(identifier: string): string {
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

  public async switchAgent(agentId: string): Promise<AgentViewState> {
    const resolvedAgentId = this.resolveAgentId(agentId);
    if (resolvedAgentId === this.input.registry.getActiveAgentId()) {
      return this.input.registry.requireRuntime(resolvedAgentId).getViewState();
    }

    const current = this.input.registry.getActiveRuntime();
    const result = await this.input.sessionService.switchHead(
      resolvedAgentId,
      current.getSnapshot(),
    );
    let runtime = this.input.registry.getEntry(resolvedAgentId)?.runtime;
    if (!runtime) {
      runtime = await this.input.runtimeFactory.createFromSessionState(
        result.head,
        result.snapshot,
        this.input.createRuntimeCallbacks(),
        result.ref,
      );
      this.input.registry.set(result.head.id, {
        runtime,
        queuedInputCount: 0,
      });
    } else {
      await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    }
    this.input.registry.setActiveAgentId(resolvedAgentId);
    this.input.emitChange();
    return runtime.getViewState();
  }

  public async switchAgentRelative(offset: number): Promise<AgentViewState> {
    const agents = this.getNavigableAgents();
    if (agents.length === 0) {
      throw new Error("当前没有可切换的 agent。");
    }
    const currentIndex = agents.findIndex((agent) => {
      return agent.id === this.input.registry.getActiveAgentId();
    });
    if (currentIndex < 0) {
      return this.switchAgent(agents[0]!.id);
    }
    const nextIndex = (currentIndex + offset + agents.length) % agents.length;
    return this.switchAgent(agents[nextIndex]!.id);
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
