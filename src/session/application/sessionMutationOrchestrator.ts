import type {
  SessionAbstractAsset,
  SessionCommitRecord,
  SessionNode,
  SessionSnapshot,
  SessionWorkingHead,
} from "../../types.js";
import type {
  SessionCommitResult,
  SessionMutationResult,
} from "./sessionServiceTypes.js";
import { createId } from "../../utils/index.js";
import { cloneSnapshotForHead, dedupeAssets } from "../domain/sessionDomain.js";

interface SessionMutationContext {
  runRepoMutation<T>(
    action: () => Promise<T>,
    input?: {
      headIds?: string[];
      reloadRepo?: boolean;
    },
  ): Promise<T>;
  ensureSnapshotNode(
    headId: string,
    snapshot: SessionSnapshot,
    input: {
      force: boolean;
      kind: "checkpoint" | "compact";
    },
  ): Promise<SessionNode | undefined>;
  requireHead(headId: string): Promise<SessionWorkingHead>;
  requireNode(nodeId: string): Promise<SessionNode>;
  loadWorkingSnapshot(headId: string): Promise<SessionSnapshot>;
  getHeadStatus(headId?: string, snapshot?: SessionSnapshot): Promise<SessionMutationResult["ref"]>;
  saveRepoMetadata(): Promise<void>;
  resolveRef(ref: string): Promise<
    | { kind: "branch"; ref: { name: string }; node: SessionNode }
    | { kind: "tag"; ref: { name: string }; node: SessionNode }
    | { kind: "commit"; commit: { id: string }; node: SessionNode }
    | { kind: "node"; node: SessionNode }
  >;
  buildSyntheticSourceHead(
    node: SessionNode,
    name?: string,
  ): SessionWorkingHead;
  findAttachedHeadForRef(
    ref: string,
    nodeId: string,
  ): SessionWorkingHead | undefined;
  mergeResolvedSourceIntoHead(
    targetHead: SessionWorkingHead,
    sourceHead: SessionWorkingHead,
    assets: string[],
  ): Promise<SessionMutationResult>;
  getCommits(): SessionCommitRecord[];
  graphStore: {
    saveCommits(commits: SessionCommitRecord[]): Promise<void>;
    saveNode(node: SessionNode): Promise<void>;
    saveHead(head: SessionWorkingHead): Promise<void>;
  };
  getAssetProviders(): Array<{
    kind: string;
    merge(input: {
      targetHead: SessionWorkingHead;
      sourceHead: SessionWorkingHead;
      targetState: unknown;
      sourceState: unknown;
      targetSnapshot: SessionSnapshot;
      sourceSnapshot: SessionSnapshot;
      sessionRoot: string;
    }): Promise<{
      targetState: unknown;
      mergeAssets?: SessionAbstractAsset[];
    }>;
  }>;
  sessionRoot: string;
  updateBranchHead(branchName: string, headNodeId: string): void;
}

export class SessionMutationOrchestrator {
  public constructor(private readonly context: SessionMutationContext) {}

  public async flushCheckpointIfDirty(
    snapshot: SessionSnapshot,
  ): Promise<boolean> {
    return this.context.runRepoMutation(async () => {
      const node = await this.context.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "checkpoint",
      });
      return Boolean(node);
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async flushCheckpointOnExit(
    snapshot: SessionSnapshot,
  ): Promise<boolean> {
    return this.flushCheckpointIfDirty(snapshot);
  }

  public async flushCompactSnapshot(
    snapshot: SessionSnapshot,
  ): Promise<boolean> {
    return this.context.runRepoMutation(async () => {
      const node = await this.context.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "compact",
      });
      return Boolean(node);
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async createCommit(
    message: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionCommitResult> {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new Error("commit message 不能为空。");
    }

    return this.context.runRepoMutation(async () => {
      const checkpointNode = await this.context.ensureSnapshotNode(
        snapshot.workingHeadId,
        snapshot,
        {
          force: false,
          kind: "checkpoint",
        },
      );
      const head = await this.context.requireHead(snapshot.workingHeadId);
      const commits = this.context.getCommits();
      const commit: SessionCommitRecord = {
        id: createId("commit"),
        message: trimmedMessage,
        nodeId: checkpointNode?.id ?? head.currentNodeId,
        headId: head.id,
        sessionId: head.sessionId,
        createdAt: new Date().toISOString(),
      };
      commits.push(commit);
      await this.context.graphStore.saveCommits(commits);
      await this.context.saveRepoMetadata();

      return {
        commit,
        ref: await this.context.getHeadStatus(head.id, snapshot),
        head,
        message: `已创建 commit ${commit.id}。`,
      };
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async merge(
    sourceRef: string,
    snapshot: SessionSnapshot,
    assets: string[] = ["digest", "memory"],
  ): Promise<SessionMutationResult> {
    return this.mergeRefIntoHead(snapshot.workingHeadId, sourceRef, assets, snapshot);
  }

  public async mergeHeadIntoHead(
    targetHeadId: string,
    sourceHeadId: string,
    assets: string[] = ["digest", "memory"],
    targetSnapshot?: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    return this.context.runRepoMutation(async () => {
      if (targetSnapshot && targetSnapshot.workingHeadId === targetHeadId) {
        await this.context.ensureSnapshotNode(targetHeadId, targetSnapshot, {
          force: false,
          kind: "checkpoint",
        });
      }

      const targetHead = await this.context.requireHead(targetHeadId);
      const sourceHead = await this.context.requireHead(sourceHeadId);
      if (targetHead.id === sourceHead.id) {
        throw new Error("sourceHead 与 targetHead 相同，无法 merge。");
      }

      return this.context.mergeResolvedSourceIntoHead(targetHead, sourceHead, assets);
    }, {
      headIds: targetSnapshot ? [targetHeadId] : [],
    });
  }

  public async mergeRefIntoHead(
    targetHeadId: string,
    sourceRef: string,
    assets: string[] = ["digest", "memory"],
    targetSnapshot?: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    return this.context.runRepoMutation(async () => {
      if (targetSnapshot && targetSnapshot.workingHeadId === targetHeadId) {
        await this.context.ensureSnapshotNode(targetHeadId, targetSnapshot, {
          force: false,
          kind: "checkpoint",
        });
      }

      const targetHead = await this.context.requireHead(targetHeadId);
      const resolved = await this.context.resolveRef(sourceRef);
      if (resolved.node.id === targetHead.currentNodeId) {
        throw new Error("sourceRef 与当前 head 相同，无法 merge。");
      }

      const sourceHead =
        resolved.kind === "node"
          ? this.context.buildSyntheticSourceHead(resolved.node)
          : this.context.findAttachedHeadForRef(sourceRef, resolved.node.id)
            ?? this.context.buildSyntheticSourceHead(resolved.node, sourceRef);

      return this.context.mergeResolvedSourceIntoHead(targetHead, sourceHead, assets);
    }, {
      headIds: targetSnapshot ? [targetHeadId] : [],
    });
  }
}
