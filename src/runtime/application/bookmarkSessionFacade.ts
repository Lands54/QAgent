import type {
  BookmarkListView,
  BookmarkView,
  MemoryRecord,
  SessionCommitListView,
  SessionCommitRecord,
  SessionHeadListView,
  SessionListView,
  SessionLogEntry,
  SessionRefInfo,
} from "../../types.js";
import type {
  SessionCheckoutResult,
  SessionService,
} from "../../session/index.js";
import type { AgentRuntimeCallbacks } from "../agentRuntime.js";
import { AgentRuntimeFactory } from "../agentRuntimeFactory.js";
import { AgentLifecycleService } from "./agentLifecycleService.js";
import { AgentNavigationService } from "./agentNavigationService.js";
import { AgentRegistry } from "./agentRegistry.js";
import { RuntimeViewProjector } from "./runtimeViewProjector.js";

export class BookmarkSessionFacade {
  public constructor(
    private readonly registry: AgentRegistry,
    private readonly navigation: AgentNavigationService,
    private readonly runtimeFactory: AgentRuntimeFactory,
    private readonly lifecycle: AgentLifecycleService,
    private readonly sessionService: SessionService,
    private readonly projector: RuntimeViewProjector,
    private readonly createRuntimeCallbacks: () => AgentRuntimeCallbacks,
    private readonly emitChange: () => void,
  ) {}

  public async listBookmarks(
    executorId = this.registry.getActiveAgentId(),
  ): Promise<BookmarkListView> {
    const refs = await this.listSessionRefs(executorId);
    return {
      bookmarks: [
        ...refs.branches.map((branch) => this.projector.toBookmarkView("branch", branch)),
        ...refs.tags.map((tag) => this.projector.toBookmarkView("tag", tag)),
      ],
    };
  }

  public async getBookmarkStatus(
    executorId = this.registry.getActiveAgentId(),
  ): Promise<{
    current?: string;
    bookmarks: BookmarkView[];
  }> {
    const current = await this.getSessionGraphStatus(executorId);
    const bookmarks = await this.listBookmarks(executorId);
    return {
      current: current.label,
      bookmarks: bookmarks.bookmarks,
    };
  }

  public async createBookmark(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.createSessionBranch(name, executorId);
  }

  public async createTagBookmark(
    name: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.createSessionTag(name, executorId);
  }

  public async switchBookmark(
    bookmark: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    return this.switchSessionRef(bookmark, executorId);
  }

  public async mergeBookmark(
    source: string,
    executorId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.mergeSessionRef(source, executorId);
  }

  public async listMemory(
    limit?: number,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<MemoryRecord[]> {
    return this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId)).listMemory(limit);
  }

  public async saveMemory(input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }, agentId = this.registry.getActiveAgentId()): Promise<MemoryRecord> {
    return this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId)).saveMemory(input);
  }

  public async showMemory(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<MemoryRecord | undefined> {
    return this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId)).showMemory(name);
  }

  public async getSessionGraphStatus(agentId?: string): Promise<SessionRefInfo> {
    const resolvedAgentId = agentId
      ? this.navigation.resolveExecutorId(agentId)
      : this.registry.getActiveAgentId();
    const runtime = this.registry.requireRuntime(resolvedAgentId);
    const ref = runtime.getRef();
    if (ref) {
      return ref;
    }
    return this.sessionService.getHeadStatus(runtime.headId, runtime.getSnapshot());
  }

  public async listSessionRefs(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionListView> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    return this.sessionService.listRefs(runtime.getSnapshot());
  }

  public async listSessionHeads(
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionHeadListView> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    return this.sessionService.listHeads(runtime.getSnapshot());
  }

  public async listSessionCommits(
    limit?: number,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCommitListView> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    return this.sessionService.listCommits(limit, runtime.getSnapshot());
  }

  public async listSessionGraphLog(limit?: number): Promise<SessionLogEntry[]> {
    return this.sessionService.graphLog(limit);
  }

  public async listSessionLog(limit?: number): Promise<SessionLogEntry[]> {
    return this.listSessionGraphLog(limit);
  }

  public async createSessionBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.createBranch(name, runtime.getSnapshot());
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async forkSessionBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.forkBranch(name, runtime.getSnapshot());
    const nextRuntime = await this.runtimeFactory.createFromSessionState(
      result.head,
      result.snapshot,
      this.createRuntimeCallbacks(),
      result.ref,
    );
    this.registry.set(nextRuntime.agentId, {
      runtime: nextRuntime,
    });
    this.registry.setActiveAgentId(nextRuntime.agentId);
    this.emitChange();
    return result.ref;
  }

  public async switchSessionCreateBranch(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    return this.forkSessionBranch(name, agentId);
  }

  public async checkoutSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.checkout(ref, runtime.getSnapshot());
    await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    this.emitChange();
    return result;
  }

  public async switchSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCheckoutResult> {
    return this.checkoutSessionRef(ref, agentId);
  }

  public async commitSession(
    message: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionCommitRecord> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.createCommit(
      message,
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.commit;
  }

  public async createSessionTag(
    name: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.createTag(name, runtime.getSnapshot());
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async mergeSessionRef(
    ref: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.merge(ref, runtime.getSnapshot());
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async forkSessionHead(name: string): Promise<SessionRefInfo> {
    const active = this.registry.getActiveRuntime();
    const result = await this.sessionService.forkHead(name, {
      sourceHeadId: active.headId,
      activate: false,
      runtimeState: {
        agentKind: "interactive",
        autoMemoryFork: true,
        retainOnCompletion: true,
      },
    });
    const runtime = await this.runtimeFactory.createFromSessionState(
      result.head,
      result.snapshot,
      this.createRuntimeCallbacks(),
      result.ref,
    );
    this.registry.set(runtime.agentId, {
      runtime,
    });
    this.emitChange();
    return result.ref;
  }

  public async switchSessionHead(headId: string): Promise<SessionRefInfo> {
    const view = await this.navigation.switchWorkline(headId);
    return this.sessionService.getHeadStatus(view.headId);
  }

  public async attachSessionHead(
    headId: string,
    ref: string,
  ): Promise<SessionRefInfo> {
    const resolvedHeadId = this.navigation.resolveWorklineId(headId);
    const runtime = this.registry.requireRuntimeByHeadId(resolvedHeadId);
    const result = await this.sessionService.attachHead(
      resolvedHeadId,
      ref,
      runtime.getSnapshot(),
    );
    await runtime.replaceSnapshot(result.snapshot, result.head, result.ref);
    this.emitChange();
    return result.ref;
  }

  public async detachSessionHead(headId: string): Promise<SessionRefInfo> {
    const resolvedHeadId = this.navigation.resolveWorklineId(headId);
    const runtime = this.registry.requireRuntimeByHeadId(resolvedHeadId);
    const result = await this.sessionService.detachHead(resolvedHeadId);
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async mergeSessionHead(
    sourceHeadId: string,
    agentId = this.registry.getActiveAgentId(),
  ): Promise<SessionRefInfo> {
    const resolvedSourceHeadId = this.navigation.resolveWorklineId(sourceHeadId);
    const runtime = this.registry.requireRuntime(this.navigation.resolveExecutorId(agentId));
    const result = await this.sessionService.mergeHeadIntoHead(
      runtime.headId,
      resolvedSourceHeadId,
      ["digest", "memory"],
      runtime.getSnapshot(),
    );
    await runtime.refreshSessionState();
    this.emitChange();
    return result.ref;
  }

  public async closeSessionHead(headId: string): Promise<SessionRefInfo> {
    const runtime = this.registry.requireRuntimeByHeadId(
      this.navigation.resolveWorklineId(headId),
    );
    await this.lifecycle.closeAgent(runtime.agentId);
    return this.sessionService.getHeadStatus(
      this.registry.getActiveRuntime().headId,
      this.registry.getActiveRuntime().getSnapshot(),
    );
  }
}
