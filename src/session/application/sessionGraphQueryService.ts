import type {
  SessionBranchRef,
  SessionCommitListView,
  SessionCommitRecord,
  SessionHeadListItem,
  SessionHeadListView,
  SessionListView,
  SessionLogEntry,
  SessionNode,
  SessionRefInfo,
  SessionRepoState,
  SessionSnapshot,
  SessionTagRef,
  SessionWorkingHead,
} from "../../types.js";
import {
  attachmentLabel,
  attachmentModeToRefMode,
  cloneSnapshotForHead,
  snapshotHash,
} from "../domain/sessionDomain.js";
import { SessionGraphStore } from "../sessionGraphStore.js";

interface SessionGraphQueryContext {
  graphStore: SessionGraphStore;
  ensureRepoLoaded(): Promise<void>;
  requireRepoState(): SessionRepoState;
  requireHead(headId: string): Promise<SessionWorkingHead>;
  requireNode(nodeId: string): Promise<SessionNode>;
  loadWorkingSnapshot(headId: string): Promise<SessionSnapshot>;
  getHeads(): SessionWorkingHead[];
  getBranches(): SessionBranchRef[];
  getTags(): SessionTagRef[];
  getCommits(): SessionCommitRecord[];
}

export class SessionGraphQueryService {
  public constructor(private readonly context: SessionGraphQueryContext) {}

  public async getActiveHead(): Promise<SessionWorkingHead> {
    await this.context.ensureRepoLoaded();
    return this.context.requireHead(this.context.requireRepoState().activeWorkingHeadId);
  }

  public async getHead(headId?: string): Promise<SessionWorkingHead> {
    await this.context.ensureRepoLoaded();
    return this.context.requireHead(headId ?? this.context.requireRepoState().activeWorkingHeadId);
  }

  public async getHeadSnapshot(headId?: string): Promise<SessionSnapshot> {
    const head = await this.getHead(headId);
    return this.context.loadWorkingSnapshot(head.id);
  }

  public async getHeadStatus(
    headId?: string,
    snapshot?: SessionSnapshot,
  ): Promise<SessionRefInfo> {
    const head = await this.getHead(headId);
    const headSnapshot =
      snapshot && snapshot.workingHeadId === head.id
        ? cloneSnapshotForHead(snapshot, head)
        : await this.context.loadWorkingSnapshot(head.id);
    const node = await this.context.requireNode(head.currentNodeId);

    return {
      mode: attachmentModeToRefMode(head.attachment.mode),
      name: head.attachment.name,
      label: attachmentLabel(head.attachment),
      headNodeId: head.currentNodeId,
      workingHeadId: head.id,
      workingHeadName: head.name,
      sessionId: head.sessionId,
      writerLeaseBranch: head.writerLease?.branchName,
      active: head.id === this.context.requireRepoState().activeWorkingHeadId,
      dirty: snapshotHash(headSnapshot) !== node.snapshotHash,
    };
  }

  public async getStatus(snapshot?: SessionSnapshot): Promise<SessionRefInfo> {
    await this.context.ensureRepoLoaded();
    const headId = snapshot?.workingHeadId ?? this.context.requireRepoState().activeWorkingHeadId;
    return this.getHeadStatus(headId, snapshot);
  }

  public async listHeads(snapshot?: SessionSnapshot): Promise<SessionHeadListView> {
    await this.context.ensureRepoLoaded();
    const items = await Promise.all(
      this.context
        .getHeads()
        .filter((head) => head.status !== "closed")
        .map(async (head): Promise<SessionHeadListItem> => {
          const ref = await this.getHeadStatus(
            head.id,
            snapshot?.workingHeadId === head.id ? snapshot : undefined,
          );
          return {
            id: head.id,
            name: head.name,
            sessionId: head.sessionId,
            attachmentLabel: ref.label,
            currentNodeId: head.currentNodeId,
            writerLeaseBranch: head.writerLease?.branchName,
            active: ref.active,
            status: head.status,
            dirty: ref.dirty,
            createdAt: head.createdAt,
            updatedAt: head.updatedAt,
          };
        }),
    );

    return {
      heads: items.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  public async listRefs(snapshot?: SessionSnapshot): Promise<SessionListView> {
    const status = await this.getStatus(snapshot);

    return {
      branches: this.context.getBranches().map((branch) => ({
        name: branch.name,
        targetNodeId: branch.headNodeId,
        current: status.mode === "branch" && status.name === branch.name,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
      })),
      tags: this.context.getTags().map((tag) => ({
        name: tag.name,
        targetNodeId: tag.targetNodeId,
        current: status.mode === "detached-tag" && status.name === tag.name,
        createdAt: tag.createdAt,
      })),
    };
  }

  public async listCommits(
    limit = 20,
    snapshot?: SessionSnapshot,
  ): Promise<SessionCommitListView> {
    await this.context.ensureRepoLoaded();
    const status = await this.getStatus(snapshot);

    return {
      commits: [...this.context.getCommits()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((commit) => ({
          ...commit,
          current: commit.nodeId === status.headNodeId,
        })),
    };
  }

  public async graphLog(limit = 20): Promise<SessionLogEntry[]> {
    await this.context.ensureRepoLoaded();
    const nodes = await this.context.graphStore.listNodes();
    const refsByNode = new Map<string, string[]>();

    for (const branch of this.context.getBranches()) {
      const refs = refsByNode.get(branch.headNodeId) ?? [];
      refs.push(`branch:${branch.name}`);
      refsByNode.set(branch.headNodeId, refs);
    }

    for (const tag of this.context.getTags()) {
      const refs = refsByNode.get(tag.targetNodeId) ?? [];
      refs.push(`tag:${tag.name}`);
      refsByNode.set(tag.targetNodeId, refs);
    }

    for (const head of this.context.getHeads()) {
      if (head.status === "closed") {
        continue;
      }
      const refs = refsByNode.get(head.currentNodeId) ?? [];
      refs.push(`head:${head.name}`);
      refsByNode.set(head.currentNodeId, refs);
    }

    return [...nodes]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        parentNodeIds: node.parentNodeIds,
        refs: refsByNode.get(node.id) ?? [],
        summaryTitle: node.abstractAssets[0]?.title,
        createdAt: node.createdAt,
      }));
  }

  public async log(limit = 20): Promise<SessionLogEntry[]> {
    return this.graphLog(limit);
  }
}
