import type { AgentViewState } from "../../types.js";
import type { HeadAgentRuntime } from "../agentRuntime.js";

export interface ManagedAgentEntry {
  runtime: HeadAgentRuntime;
  sourceAgentId?: string;
  mergeIntoAgentId?: string;
  mergeAssets?: string[];
  mergePending?: boolean;
}

export class AgentRegistry {
  private readonly runtimes = new Map<string, ManagedAgentEntry>();
  private activeAgentId = "";

  public initializeActiveAgent(agentId: string): void {
    this.activeAgentId = agentId;
  }

  public getActiveAgentId(): string {
    return this.activeAgentId;
  }

  public setActiveAgentId(agentId: string): void {
    this.activeAgentId = agentId;
  }

  public set(agentId: string, entry: ManagedAgentEntry): void {
    this.runtimes.set(agentId, entry);
  }

  public delete(agentId: string): boolean {
    return this.runtimes.delete(agentId);
  }

  public getEntry(agentId: string): ManagedAgentEntry | undefined {
    return this.runtimes.get(agentId);
  }

  public getEntryByHeadId(headId: string): ManagedAgentEntry | undefined {
    return this.getEntries().find((entry) => entry.runtime.headId === headId);
  }

  public getEntries(): ManagedAgentEntry[] {
    return [...this.runtimes.values()];
  }

  public getAgentIds(): string[] {
    return [...this.runtimes.keys()];
  }

  public requireRuntime(agentId: string): HeadAgentRuntime {
    const runtime = this.runtimes.get(agentId)?.runtime;
    if (!runtime) {
      throw new Error(`未找到 agent：${agentId}`);
    }
    return runtime;
  }

  public requireRuntimeByHeadId(headId: string): HeadAgentRuntime {
    const runtime = this.getEntryByHeadId(headId)?.runtime;
    if (!runtime) {
      throw new Error(`未找到 working head：${headId}`);
    }
    return runtime;
  }

  public getActiveRuntime(): HeadAgentRuntime {
    return this.requireRuntime(this.activeAgentId);
  }

  public listAgentViews(): AgentViewState[] {
    return this.getEntries().map((entry) => entry.runtime.getViewState());
  }

  public hasBusyAgents(): boolean {
    return this.getEntries().some((entry) => {
      const view = entry.runtime.getViewState();
      return entry.runtime.isRunning()
        || Boolean(view.pendingApproval)
        || view.queuedInputCount > 0;
    });
  }
}
