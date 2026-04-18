import type {
  AgentViewState,
  ExecutorListView,
  ExecutorView,
} from "../../types.js";
import type { HeadAgentRuntime } from "../agentRuntime.js";
import { AgentNavigationService } from "./agentNavigationService.js";
import { AgentRegistry } from "./agentRegistry.js";
import { RuntimeViewProjector } from "./runtimeViewProjector.js";

export class ExecutorService {
  public constructor(
    private readonly registry: AgentRegistry,
    private readonly navigation: AgentNavigationService,
    private readonly projector: RuntimeViewProjector,
  ) {}

  public listAgents(): AgentViewState[] {
    return this.projector.sortVisibleAgents(this.registry.listAgentViews());
  }

  public listHelperAgents(): AgentViewState[] {
    return this.listAgents().filter((agent) => Boolean(agent.helperType));
  }

  public listLegacyAgents(): AgentViewState[] {
    return this.listAgents().filter((agent) => {
      return !agent.helperType && agent.name.startsWith("legacy-");
    });
  }

  public getAgentStatus(agentId?: string): AgentViewState {
    const resolvedAgentId = agentId
      ? this.navigation.resolveExecutorId(agentId)
      : this.registry.getActiveAgentId();
    return this.registry.requireRuntime(resolvedAgentId).getViewState();
  }

  public listExecutors(): ExecutorListView {
    return {
      executors: this.listAgents().map((agent) => this.projector.toExecutorView(agent)),
    };
  }

  public getExecutorStatus(executorId?: string): ExecutorView {
    return this.projector.toExecutorView(this.getAgentStatus(executorId));
  }

  public async interruptExecutor(executorId?: string): Promise<void> {
    const resolvedAgentId = executorId
      ? this.navigation.resolveExecutorId(executorId)
      : this.registry.getActiveAgentId();
    await this.registry.requireRuntime(resolvedAgentId).interrupt();
  }

  public async resumeExecutor(executorId?: string): Promise<void> {
    const resolvedAgentId = executorId
      ? this.navigation.resolveExecutorId(executorId)
      : this.registry.getActiveAgentId();
    await this.registry.requireRuntime(resolvedAgentId).resume();
  }

  public async switchAgent(agentId: string): Promise<AgentViewState> {
    return this.navigation.switchExecutor(agentId);
  }

  public async switchAgentRelative(offset: number): Promise<AgentViewState> {
    return this.navigation.switchWorklineRelative(offset);
  }

  public getActiveRuntime(): HeadAgentRuntime {
    return this.registry.getActiveRuntime();
  }

  public getRuntime(agentId: string): HeadAgentRuntime {
    return this.registry.requireRuntime(agentId);
  }

  public getRuntimeByWorklineId(worklineId: string): HeadAgentRuntime {
    return this.registry.requireRuntimeByHeadId(
      this.navigation.resolveWorklineId(worklineId),
    );
  }
}
