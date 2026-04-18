import type { WorklineListView, WorklineView } from "../../types.js";
import { AgentLifecycleService } from "./agentLifecycleService.js";
import type { BookmarkSessionFacade } from "./bookmarkSessionFacade.js";
import { AgentNavigationService } from "./agentNavigationService.js";
import { AgentRegistry } from "./agentRegistry.js";
import { ExecutorService } from "./executorService.js";
import { RuntimeViewProjector } from "./runtimeViewProjector.js";

export class WorklineService {
  public constructor(
    private readonly registry: AgentRegistry,
    private readonly navigation: AgentNavigationService,
    private readonly lifecycle: AgentLifecycleService,
    private readonly executorService: ExecutorService,
    private readonly bookmarkSessionFacade: BookmarkSessionFacade,
    private readonly projector: RuntimeViewProjector,
  ) {}

  public listWorklines(): WorklineListView {
    return {
      worklines: this.executorService
        .listAgents()
        .filter((agent) => !agent.helperType)
        .map((agent) => this.projector.toWorklineView(agent)),
    };
  }

  public getWorklineStatus(worklineId?: string): WorklineView {
    const resolvedWorklineId = worklineId
      ? this.navigation.resolveWorklineId(worklineId)
      : this.registry.getActiveRuntime().headId;
    return this.projector.toWorklineView(
      this.registry.requireRuntimeByHeadId(resolvedWorklineId).getViewState(),
    );
  }

  public async createWorkline(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    const ref = await this.bookmarkSessionFacade.forkSessionBranch(name, executorId);
    return this.getWorklineStatus(ref.workingHeadId);
  }

  public async switchWorkline(
    worklineId: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    const resolvedExecutorId = this.navigation.resolveExecutorId(executorId);
    const agent = await this.navigation.switchWorkline(worklineId, resolvedExecutorId);
    return this.projector.toWorklineView(agent);
  }

  public async switchWorklineRelative(
    offset: number,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    this.registry.setActiveAgentId(this.navigation.resolveExecutorId(executorId));
    const agent = await this.navigation.switchWorklineRelative(offset);
    return this.projector.toWorklineView(agent);
  }

  public async closeWorkline(worklineId: string): Promise<WorklineView> {
    const resolvedWorklineId = this.navigation.resolveWorklineId(worklineId);
    const runtime = this.registry.requireRuntimeByHeadId(resolvedWorklineId);
    const agent = await this.lifecycle.closeAgent(runtime.agentId);
    const closedRuntime = this.registry.getEntryByHeadId(resolvedWorklineId)?.runtime;
    const ref = closedRuntime?.getRef();
    return this.projector.toClosedWorklineView(agent, ref ? {
      mode: ref.mode,
      label: ref.label,
      writerLeaseBranch: ref.writerLeaseBranch,
    } : undefined);
  }

  public async detachWorkline(worklineId?: string): Promise<WorklineView> {
    const resolvedWorklineId = worklineId
      ? this.navigation.resolveWorklineId(worklineId)
      : this.registry.getActiveRuntime().headId;
    await this.bookmarkSessionFacade.detachSessionHead(resolvedWorklineId);
    return this.getWorklineStatus(resolvedWorklineId);
  }

  public async mergeWorkline(
    source: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<WorklineView> {
    await this.bookmarkSessionFacade.mergeSessionHead(source, executorId);
    return this.getWorklineStatus(undefined);
  }
}
