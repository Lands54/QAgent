import { attachmentLabel, cloneSnapshotForHead, formatUtcTimestamp } from "../domain/sessionDomain.js";
import { createId } from "../../utils/index.js";
import type {
  SessionHeadAttachment,
  SessionNode,
  SessionSnapshot,
  SessionWorkingHead,
} from "../../types.js";
import type {
  SessionCheckoutResult,
  SessionHeadForkResult,
  SessionMutationResult,
} from "./sessionServiceTypes.js";

interface ForkHeadOptions {
  sourceHeadId?: string;
  sourceRef?: string;
  activate?: boolean;
  attachment?: SessionHeadAttachment;
  acquireWriterLease?: boolean;
  runtimeState?: {
    agentKind?: SessionWorkingHead["runtimeState"]["agentKind"];
    autoMemoryFork?: boolean;
    retainOnCompletion?: boolean;
    promptProfile?: SessionWorkingHead["runtimeState"]["promptProfile"];
    toolMode?: SessionWorkingHead["runtimeState"]["toolMode"];
    uiContextEnabled?: boolean;
  };
}

interface SessionCheckoutContext {
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
  ): Promise<unknown>;
  requireHead(headId: string): Promise<SessionWorkingHead>;
  getActiveHead(): Promise<SessionWorkingHead>;
  loadWorkingSnapshot(headId: string): Promise<SessionSnapshot>;
  sessionStore: {
    saveSnapshot(snapshot: SessionSnapshot): Promise<void>;
  };
  graphStore: {
    saveHead(head: SessionWorkingHead): Promise<void>;
    saveBranches(branches: unknown): Promise<void>;
  };
  getHeadStatus(headId?: string, snapshot?: SessionSnapshot): Promise<SessionMutationResult["ref"]>;
  resolveRef(ref: string): Promise<
    | { kind: "branch"; ref: { name: string }; node: SessionNode }
    | { kind: "tag"; ref: { name: string }; node: SessionNode }
    | { kind: "commit"; commit: { id: string }; node: SessionNode }
    | { kind: "node"; node: SessionNode }
  >;
  assertWriterLeaseAvailable(headId: string, branchName: string): Promise<void>;
  saveRepoMetadata(): Promise<void>;
  requireRepoState(): {
    activeWorkingHeadId: string;
  };
  assertValidRefName(name: string, kind: "branch" | "tag"): void;
  assertRefNameAvailable(name: string): void;
  forkHeadInternal(
    name: string,
    options: ForkHeadOptions,
    headId: string,
  ): Promise<SessionHeadForkResult>;
  ensureUniqueBranchName(baseName: string): Promise<string>;
  getBranches(): Array<{
    name: string;
    headNodeId: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

export class SessionCheckoutService {
  public constructor(private readonly context: SessionCheckoutContext) {}

  public async forkBranch(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionHeadForkResult> {
    const nextHeadId = createId("head");
    return this.context.runRepoMutation(async () => {
      this.context.assertValidRefName(name, "branch");
      this.context.assertRefNameAvailable(name);
      await this.context.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "checkpoint",
      });

      const sourceHead = await this.context.requireHead(snapshot.workingHeadId);
      this.context.getBranches().push({
        name,
        headNodeId: sourceHead.currentNodeId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.context.graphStore.saveBranches(this.context.getBranches());

      return this.context.forkHeadInternal(
        name,
        {
          sourceHeadId: sourceHead.id,
          activate: true,
          attachment: {
            mode: "branch",
            name,
            nodeId: sourceHead.currentNodeId,
          },
          acquireWriterLease: true,
          runtimeState: {
            agentKind: "interactive",
            autoMemoryFork: true,
            retainOnCompletion: true,
            uiContextEnabled: false,
          },
        },
        nextHeadId,
      );
    }, {
      headIds: [snapshot.workingHeadId, nextHeadId],
    });
  }

  public async forkHead(
    name: string,
    options: ForkHeadOptions = {},
  ): Promise<SessionHeadForkResult> {
    const headId = createId("head");
    return this.context.runRepoMutation(() => this.context.forkHeadInternal(name, options, headId), {
      headIds: [headId],
    });
  }

  public async checkout(
    ref: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionCheckoutResult> {
    return this.checkoutRefOnHead(snapshot.workingHeadId, ref, snapshot);
  }

  public async checkoutRefOnHead(
    headId: string,
    ref: string,
    snapshot?: SessionSnapshot,
  ): Promise<SessionCheckoutResult> {
    return this.context.runRepoMutation(async () => {
      if (snapshot && snapshot.workingHeadId === headId) {
        await this.context.ensureSnapshotNode(headId, snapshot, {
          force: false,
          kind: "checkpoint",
        });
      }

      const head = await this.context.requireHead(headId);
      const resolved = await this.context.resolveRef(ref);
      if (resolved.kind === "branch") {
        await this.context.assertWriterLeaseAvailable(head.id, resolved.ref.name);
      }

      const nextAttachment: SessionHeadAttachment =
        resolved.kind === "branch"
          ? {
              mode: "branch",
              name: resolved.ref.name,
              nodeId: resolved.node.id,
            }
          : resolved.kind === "tag"
            ? {
                mode: "tag",
                name: resolved.ref.name,
                nodeId: resolved.node.id,
              }
            : {
                mode: "detached-node",
                name: resolved.node.id,
                nodeId: resolved.node.id,
              };

      const restoredSnapshot = cloneSnapshotForHead(resolved.node.snapshot, head);
      await this.context.sessionStore.saveSnapshot(restoredSnapshot);
      head.currentNodeId = resolved.node.id;
      head.attachment = nextAttachment;
      head.runtimeState.shellCwd = restoredSnapshot.shellCwd;
      head.runtimeState.status = "idle";
      head.status = "idle";
      if (resolved.kind === "branch") {
        head.writerLease = {
          branchName: resolved.ref.name,
          acquiredAt: new Date().toISOString(),
        };
      } else {
        head.writerLease = undefined;
      }
      head.updatedAt = new Date().toISOString();
      await this.context.graphStore.saveHead(head);

      return {
        snapshot: restoredSnapshot,
        ref: await this.context.getHeadStatus(head.id, restoredSnapshot),
        head,
        message: [
          `已切换到 ${attachmentLabel(nextAttachment)}。`,
          `working head: ${head.name}`,
          "工作区未自动回退。",
        ].join("\n"),
      };
    }, {
      headIds: [headId],
    });
  }

  public async attachHead(
    headId: string,
    ref: string,
    snapshot?: SessionSnapshot,
  ): Promise<SessionCheckoutResult> {
    return this.checkoutRefOnHead(headId, ref, snapshot);
  }

  public async prepareForUserInput(
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult | undefined> {
    return this.prepareHeadForUserInput(snapshot.workingHeadId, snapshot);
  }

  public async prepareHeadForUserInput(
    headId: string,
    snapshot?: SessionSnapshot,
  ): Promise<SessionMutationResult | undefined> {
    return this.context.runRepoMutation(async () => {
      const head = await this.context.requireHead(headId);
      if (head.attachment.mode !== "tag") {
        return undefined;
      }
      const tagName = head.attachment.name;

      if (snapshot && snapshot.workingHeadId === head.id) {
        await this.context.ensureSnapshotNode(head.id, snapshot, {
          force: true,
          kind: "checkpoint",
        });
      }
      const refreshedHead = await this.context.requireHead(head.id);
      const branchName = await this.context.ensureUniqueBranchName(
        `from-tag-${tagName}-${formatUtcTimestamp()}`,
      );
      const now = new Date().toISOString();
      this.context.getBranches().push({
        name: branchName,
        headNodeId: refreshedHead.currentNodeId,
        createdAt: now,
        updatedAt: now,
      });
      refreshedHead.attachment = {
        mode: "branch",
        name: branchName,
        nodeId: refreshedHead.currentNodeId,
      };
      refreshedHead.writerLease = {
        branchName,
        acquiredAt: now,
      };
      refreshedHead.updatedAt = now;
      await this.context.saveRepoMetadata();
      await this.context.graphStore.saveHead(refreshedHead);

      return {
        ref: await this.context.getHeadStatus(refreshedHead.id),
        head: refreshedHead,
        message: `已从 tag ${tagName} 自动创建并切换到分支 ${branchName}。`,
      };
    }, {
      headIds: [headId],
    });
  }
}
