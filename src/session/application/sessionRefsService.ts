import type {
  PendingApprovalCheckpoint,
  SessionBranchRef,
  SessionSnapshot,
  SessionTagRef,
  SessionWorkingHead,
} from "../../types.js";
import type { SessionMutationResult } from "./sessionServiceTypes.js";
import { SessionGraphStore } from "../sessionGraphStore.js";
import { SessionStore } from "../sessionStore.js";

interface SessionRefsContext {
  graphStore: SessionGraphStore;
  sessionStore: SessionStore;
  runRepoMutation<T>(
    action: () => Promise<T>,
    input?: {
      headIds?: string[];
      reloadRepo?: boolean;
    },
  ): Promise<T>;
  runHeadMutation<T>(headId: string, action: () => Promise<T>): Promise<T>;
  ensureSnapshotNode(
    headId: string,
    snapshot: SessionSnapshot,
    input: {
      force: boolean;
      kind: "checkpoint" | "compact";
    },
  ): Promise<unknown>;
  requireHead(headId: string): Promise<SessionWorkingHead>;
  getHead(headId?: string): Promise<SessionWorkingHead>;
  getHeadStatus(headId?: string, snapshot?: SessionSnapshot): Promise<SessionMutationResult["ref"]>;
  assertValidRefName(name: string, kind: "branch" | "tag"): void;
  assertRefNameAvailable(name: string): void;
  assertWriterLeaseAvailable(headId: string, branchName: string): Promise<void>;
  getBranches(): SessionBranchRef[];
  getTags(): SessionTagRef[];
}

export class SessionRefsService {
  public constructor(private readonly context: SessionRefsContext) {}

  public async getPendingApprovalCheckpoint(
    headId?: string,
  ): Promise<PendingApprovalCheckpoint | undefined> {
    const head = await this.context.getHead(headId);
    return this.context.sessionStore.loadPendingApprovalCheckpoint(head.id);
  }

  public async savePendingApprovalCheckpoint(
    checkpoint: PendingApprovalCheckpoint,
  ): Promise<void> {
    await this.context.runRepoMutation(async () => {
      await this.context.sessionStore.savePendingApprovalCheckpoint(
        checkpoint.headId,
        checkpoint,
      );
      const head = await this.context.requireHead(checkpoint.headId);
      head.runtimeState.status = "awaiting-approval";
      head.status = "awaiting-approval";
      head.updatedAt = new Date().toISOString();
      await this.context.graphStore.saveHead(head);
    }, {
      headIds: [checkpoint.headId],
    });
  }

  public async clearPendingApprovalCheckpoint(headId: string): Promise<void> {
    await this.context.runHeadMutation(headId, async () => {
      await this.context.sessionStore.clearPendingApprovalCheckpoint(headId);
    });
  }

  public async createBranch(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    return this.context.runRepoMutation(async () => {
      this.context.assertValidRefName(name, "branch");
      this.context.assertRefNameAvailable(name);
      await this.context.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "checkpoint",
      });

      this.context.getBranches().push({
        name,
        headNodeId: (await this.context.requireHead(snapshot.workingHeadId)).currentNodeId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.context.graphStore.saveBranches(this.context.getBranches());

      const head = await this.context.requireHead(snapshot.workingHeadId);
      return {
        ref: await this.context.getHeadStatus(head.id, snapshot),
        head,
        message: `已创建分支 ${name}，当前未切换。`,
      };
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async createTag(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    return this.context.runRepoMutation(async () => {
      this.context.assertValidRefName(name, "tag");
      this.context.assertRefNameAvailable(name);
      await this.context.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "checkpoint",
      });

      const head = await this.context.requireHead(snapshot.workingHeadId);
      this.context.getTags().push({
        name,
        targetNodeId: head.currentNodeId,
        createdAt: new Date().toISOString(),
      });
      await this.context.graphStore.saveTags(this.context.getTags());

      return {
        ref: await this.context.getHeadStatus(head.id, snapshot),
        head,
        message: `已创建 tag ${name} -> ${head.currentNodeId}。`,
      };
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async acquireWriterLease(
    headId: string,
    branchName: string,
  ): Promise<SessionMutationResult> {
    return this.context.runRepoMutation(async () => {
      await this.context.assertWriterLeaseAvailable(headId, branchName);
      const head = await this.context.requireHead(headId);
      head.writerLease = {
        branchName,
        acquiredAt: new Date().toISOString(),
      };
      head.updatedAt = new Date().toISOString();
      await this.context.graphStore.saveHead(head);
      return {
        ref: await this.context.getHeadStatus(head.id),
        head,
        message: `已为 ${head.name} 获取分支 ${branchName} 的 writer lease。`,
      };
    });
  }

  public async releaseWriterLease(
    headId: string,
  ): Promise<SessionMutationResult> {
    return this.context.runRepoMutation(async () => {
      const head = await this.context.requireHead(headId);
      head.writerLease = undefined;
      head.updatedAt = new Date().toISOString();
      await this.context.graphStore.saveHead(head);
      return {
        ref: await this.context.getHeadStatus(head.id),
        head,
        message: `已释放 ${head.name} 的 writer lease。`,
      };
    });
  }
}
