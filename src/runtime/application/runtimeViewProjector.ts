import type {
  AgentViewState,
  BookmarkView,
  ExecutorView,
  SessionListView,
  WorklineView,
} from "../../types.js";
import { AgentRegistry } from "./agentRegistry.js";

export class RuntimeViewProjector {
  public constructor(private readonly registry: AgentRegistry) {}

  public sortVisibleAgents(agents: AgentViewState[]): AgentViewState[] {
    return agents
      .filter((agent) => agent.status !== "closed")
      .sort((left, right) => {
        if (left.id === this.registry.getActiveAgentId()) {
          return -1;
        }
        if (right.id === this.registry.getActiveAgentId()) {
          return 1;
        }
        return left.name.localeCompare(right.name);
      });
  }

  public toExecutorView(agent: AgentViewState): ExecutorView {
    return {
      ...agent,
      executorId: agent.id,
      worklineId: agent.headId,
      worklineName: agent.name,
      active: agent.id === this.registry.getActiveAgentId(),
    };
  }

  public toWorklineView(agent: AgentViewState): WorklineView {
    const runtime = this.registry.requireRuntime(agent.id);
    const ref = runtime.getRef();
    return {
      id: agent.headId,
      sessionId: agent.sessionId,
      name: agent.name,
      attachmentMode: ref?.mode ?? "detached-node",
      attachmentLabel: ref?.label ?? "detached",
      shellCwd: agent.shellCwd,
      dirty: agent.dirty,
      writeLock: ref?.writerLeaseBranch,
      status: agent.status,
      detail: agent.detail,
      executorKind: agent.kind,
      helperType: agent.helperType,
      pendingApproval: agent.pendingApproval,
      queuedInputCount: agent.queuedInputCount,
      lastUserPrompt: agent.lastUserPrompt,
      active: runtime.headId === this.registry.getActiveRuntime().headId,
    };
  }

  public toClosedWorklineView(
    agent: AgentViewState,
    ref?: {
      mode?: WorklineView["attachmentMode"];
      label?: string;
      writerLeaseBranch?: string;
    },
  ): WorklineView {
    return {
      id: agent.headId,
      sessionId: agent.sessionId,
      name: agent.name,
      attachmentMode: ref?.mode ?? "detached-node",
      attachmentLabel: ref?.label ?? "closed",
      shellCwd: agent.shellCwd,
      dirty: agent.dirty,
      writeLock: ref?.writerLeaseBranch,
      status: agent.status,
      detail: agent.detail,
      executorKind: agent.kind,
      helperType: agent.helperType,
      pendingApproval: agent.pendingApproval,
      queuedInputCount: agent.queuedInputCount,
      lastUserPrompt: agent.lastUserPrompt,
      active: false,
    };
  }

  public toBookmarkView(
    kind: "branch" | "tag",
    item: SessionListView["branches"][number],
  ): BookmarkView {
    return {
      name: item.name,
      kind,
      targetNodeId: item.targetNodeId,
      current: item.current,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
