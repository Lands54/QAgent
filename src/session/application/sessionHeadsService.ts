import type {
  SessionSnapshot,
  SessionWorkingHead,
} from "../../types.js";
import type {
  SessionHeadSwitchResult,
  SessionMutationResult,
} from "./sessionServiceTypes.js";
import { SessionGraphStore } from "../sessionGraphStore.js";

interface SessionHeadsContext {
  graphStore: SessionGraphStore;
  runRepoMutation<T>(
    action: () => Promise<T>,
    input?: {
      headIds?: string[];
      reloadRepo?: boolean;
    },
  ): Promise<T>;
  requireRepoState(): {
    activeWorkingHeadId: string;
  };
  getActiveHead(): Promise<SessionWorkingHead>;
  requireHead(headId: string): Promise<SessionWorkingHead>;
  saveRepoMetadata(): Promise<void>;
  loadWorkingSnapshot(headId: string): Promise<SessionSnapshot>;
  ensureSnapshotNode(
    headId: string,
    snapshot: SessionSnapshot,
    input: {
      force: boolean;
      kind: "checkpoint" | "compact";
    },
  ): Promise<unknown>;
  getHeadStatus(headId?: string, snapshot?: SessionSnapshot): Promise<SessionMutationResult["ref"]>;
}

export class SessionHeadsService {
  public constructor(private readonly context: SessionHeadsContext) {}

  public async switchHead(
    headId: string,
    currentSnapshot?: SessionSnapshot,
  ): Promise<SessionHeadSwitchResult> {
    return this.context.runRepoMutation(async () => {
      const previousHead = await this.context.getActiveHead();
      if (currentSnapshot && previousHead.id === currentSnapshot.workingHeadId) {
        await this.context.ensureSnapshotNode(previousHead.id, currentSnapshot, {
          force: false,
          kind: "checkpoint",
        });
      }

      const nextHead = await this.context.requireHead(headId);
      if (nextHead.status === "closed") {
        throw new Error(`working head 已关闭：${nextHead.name}`);
      }

      this.context.requireRepoState().activeWorkingHeadId = nextHead.id;
      await this.context.saveRepoMetadata();
      const snapshot = await this.context.loadWorkingSnapshot(nextHead.id);
      return {
        snapshot,
        ref: await this.context.getHeadStatus(nextHead.id, snapshot),
        head: nextHead,
        message: `已切换到 working head ${nextHead.name}。`,
      };
    }, {
      headIds: currentSnapshot ? [currentSnapshot.workingHeadId] : [],
    });
  }

  public async detachHead(headId: string): Promise<SessionMutationResult> {
    return this.context.runRepoMutation(async () => {
      const head = await this.context.requireHead(headId);
      head.attachment = {
        mode: "detached-node",
        name: head.currentNodeId,
        nodeId: head.currentNodeId,
      };
      head.writerLease = undefined;
      head.updatedAt = new Date().toISOString();
      await this.context.graphStore.saveHead(head);
      return {
        ref: await this.context.getHeadStatus(head.id),
        head,
        message: `已将 working head ${head.name} 置为 detached。`,
      };
    });
  }

  public async closeHead(headId: string): Promise<SessionMutationResult> {
    return this.context.runRepoMutation(async () => {
      const head = await this.context.requireHead(headId);
      if (head.id === this.context.requireRepoState().activeWorkingHeadId) {
        throw new Error("当前 active working head 不能直接关闭。");
      }

      head.status = "closed";
      head.writerLease = undefined;
      head.updatedAt = new Date().toISOString();
      await this.context.graphStore.saveHead(head);
      return {
        ref: await this.context.getHeadStatus(this.context.requireRepoState().activeWorkingHeadId),
        head,
        message: `已关闭 working head ${head.name}。`,
      };
    });
  }

  public async updateHeadRuntimeState(
    headId: string,
    patch: Partial<SessionWorkingHead["runtimeState"]>,
  ): Promise<SessionWorkingHead> {
    return this.context.runRepoMutation(async () => {
      const head = await this.context.requireHead(headId);
      head.runtimeState = {
        ...head.runtimeState,
        ...patch,
      };
      head.updatedAt = new Date().toISOString();
      await this.context.graphStore.saveHead(head);
      return head;
    });
  }
}
