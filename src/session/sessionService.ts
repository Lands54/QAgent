import { rm } from "node:fs/promises";
import path from "node:path";

import type {
  AgentKind,
  ApprovalMode,
  PendingApprovalCheckpoint,
  PromptProfile,
  SessionAbstractAsset,
  SessionAssetProvider,
  SessionBranchRef,
  SessionCommitListView,
  SessionCommitRecord,
  SessionEvent,
  SessionHeadAttachment,
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
  ToolMode,
} from "../types.js";
import { AssetOverlayService } from "./application/assetOverlayService.js";
import { SessionRepoMigrationService } from "./application/sessionRepoMigrationService.js";
import {
  buildNodeDigestAsset,
  createDigestSessionAssetProvider,
} from "./digestAssetProvider.js";
import {
  attachmentLabel,
  attachmentModeToRefMode,
  cloneSnapshotForHead,
  dedupeAssets,
  DEFAULT_BRANCH_NAME,
  formatUtcTimestamp,
  isLegacyRepoState,
  type LegacySessionRepoStateV1,
  SESSION_REF_NAME_PATTERN,
  snapshotHash,
  V1_INCOMPATIBLE_MESSAGE,
} from "./domain/sessionDomain.js";
import { SessionGraphStore } from "./sessionGraphStore.js";
import {
  SessionLockService,
  type SessionLockHandle,
  type SessionServiceLockOptions,
} from "./sessionLockService.js";
import { SessionStore } from "./sessionStore.js";
import { createId } from "../utils/index.js";

interface SessionInitializationInput {
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
  resumeSessionId?: string;
}

export interface SessionInitializationResult {
  snapshot: SessionSnapshot;
  ref: SessionRefInfo;
  head: SessionWorkingHead;
  infoMessage?: string;
}

export interface SessionMutationResult {
  ref: SessionRefInfo;
  head: SessionWorkingHead;
  message: string;
}

export interface SessionCheckoutResult extends SessionMutationResult {
  snapshot: SessionSnapshot;
}

export interface SessionHeadForkResult extends SessionMutationResult {
  snapshot: SessionSnapshot;
}

export interface SessionHeadSwitchResult extends SessionMutationResult {
  snapshot: SessionSnapshot;
}

export interface SessionCommitResult extends SessionMutationResult {
  commit: SessionCommitRecord;
}

export type SessionServiceOptions = SessionServiceLockOptions;

interface ForkHeadOptions {
  sourceHeadId?: string;
  sourceRef?: string;
  activate?: boolean;
  attachment?: SessionHeadAttachment;
  acquireWriterLease?: boolean;
  runtimeState?: {
    agentKind?: AgentKind;
    autoMemoryFork?: boolean;
    retainOnCompletion?: boolean;
    promptProfile?: PromptProfile;
    toolMode?: ToolMode;
    uiContextEnabled?: boolean;
  };
}

export class SessionService {
  private readonly sessionStore: SessionStore;
  private readonly graphStore: SessionGraphStore;
  private readonly lockService: SessionLockService;
  private readonly assetProviders: SessionAssetProvider[];
  private readonly assetOverlayService: AssetOverlayService;
  private readonly repoMigrationService: SessionRepoMigrationService;
  private repoState?: SessionRepoState;
  private branches: SessionBranchRef[] = [];
  private tags: SessionTagRef[] = [];
  private commits: SessionCommitRecord[] = [];
  private heads: SessionWorkingHead[] = [];
  private lastLoadInfoMessage?: string;

  public constructor(
    private readonly sessionRoot: string,
    assetProviders: SessionAssetProvider[] = [],
    options: SessionServiceOptions = {
      ownerKind: "session-service",
    },
  ) {
    this.sessionStore = new SessionStore(sessionRoot);
    this.graphStore = new SessionGraphStore(sessionRoot);
    this.lockService = new SessionLockService(sessionRoot, {
      ownerKind: options.ownerKind,
      processLeaseHeartbeatMs: options.processLeaseHeartbeatMs,
      processLeaseTtlMs: options.processLeaseTtlMs,
      mutationHeartbeatMs: options.mutationHeartbeatMs,
      mutationTtlMs: options.mutationTtlMs,
      mutationPollMs: options.mutationPollMs,
    });
    const providerMap = new Map<string, SessionAssetProvider>();
    providerMap.set("digest", createDigestSessionAssetProvider());
    for (const provider of assetProviders) {
      providerMap.set(provider.kind, provider);
    }
    this.assetProviders = [...providerMap.values()];
    this.assetOverlayService = new AssetOverlayService({
      sessionRoot: this.sessionRoot,
      assetProviders: this.assetProviders,
      sessionStore: this.sessionStore,
      graphStore: this.graphStore,
      ensureRepoLoaded: async () => this.ensureRepoLoaded(),
      requireHead: async (headId) => this.requireHead(headId),
      requireNode: async (nodeId) => this.requireNode(nodeId),
    });
    this.repoMigrationService = new SessionRepoMigrationService({
      sessionRoot: this.sessionRoot,
      graphStore: this.graphStore,
      sessionStore: this.sessionStore,
      runForkProviders: async (head, snapshot, sourceHead) => {
        return this.assetOverlayService.runForkProviders(head, snapshot, sourceHead);
      },
      buildNode: (input) => this.buildNode(input),
    });
  }

  public async dispose(): Promise<void> {
    await this.lockService.dispose();
  }

  public async initialize(
    input: SessionInitializationInput,
  ): Promise<SessionInitializationResult> {
    await this.ensureProcessLease();
    if (await this.graphStore.repoExists()) {
      this.lastLoadInfoMessage = undefined;
      if (input.resumeSessionId && input.resumeSessionId !== "latest") {
        await this.runRepoMutation(async () => {
          const matchedHead = this.heads.find((head) => head.sessionId === input.resumeSessionId);
          if (!matchedHead) {
            throw new Error(`未找到 working head 对应 sessionId：${input.resumeSessionId}`);
          }
          this.requireRepoState().activeWorkingHeadId = matchedHead.id;
          await this.saveRepoMetadata();
        });
      } else {
        await this.loadRepo();
      }

      const head = await this.getActiveHead();
      const snapshot = await this.loadWorkingSnapshot(head.id);
      return {
        snapshot,
        ref: await this.getHeadStatus(head.id, snapshot),
        head,
        infoMessage: this.lastLoadInfoMessage,
      };
    }

    const now = new Date().toISOString();
    const headId = createId("head");
    const head: SessionWorkingHead = {
      id: headId,
      name: DEFAULT_BRANCH_NAME,
      currentNodeId: "",
      sessionId: createId("session"),
      attachment: {
        mode: "branch",
        name: DEFAULT_BRANCH_NAME,
        nodeId: "",
      },
      writerLease: {
        branchName: DEFAULT_BRANCH_NAME,
        acquiredAt: now,
      },
      runtimeState: {
        shellCwd: input.shellCwd,
        agentKind: "interactive",
        autoMemoryFork: true,
        retainOnCompletion: true,
        promptProfile: "default",
        toolMode: "shell",
        uiContextEnabled: false,
        status: "idle",
      },
      assetState: {},
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    let snapshot!: SessionSnapshot;
    try {
      await this.runRepoMutation(
        async () => {
          snapshot = await this.sessionStore.initializeHeadSession({
            workingHeadId: head.id,
            sessionId: head.sessionId,
            cwd: input.cwd,
            shellCwd: input.shellCwd,
            approvalMode: input.approvalMode,
          });
          const seededAssetState = await this.runForkProviders(head, snapshot);
          head.assetState = seededAssetState;
          const rootNode = this.buildNode({
            kind: "root",
            parentNodeIds: [],
            snapshot,
            assetState: seededAssetState,
          });
          head.currentNodeId = rootNode.id;
          head.attachment = {
            mode: "branch",
            name: DEFAULT_BRANCH_NAME,
            nodeId: rootNode.id,
          };

          const mainBranch: SessionBranchRef = {
            name: DEFAULT_BRANCH_NAME,
            headNodeId: rootNode.id,
            createdAt: now,
            updatedAt: now,
          };
          this.repoState = {
            version: 2,
            activeWorkingHeadId: head.id,
            defaultBranchName: DEFAULT_BRANCH_NAME,
            createdAt: now,
            updatedAt: now,
          };
          this.branches = [mainBranch];
          this.tags = [];
          this.commits = [];
          this.heads = [head];
          await this.graphStore.initializeRepo({
            state: this.repoState,
            branches: this.branches,
            tags: this.tags,
            commits: this.commits,
            nodes: [rootNode],
            heads: [head],
          });
        },
        {
          headIds: [headId],
          reloadRepo: false,
        },
      );
    } catch (error) {
      await this.rollbackInitializationFailure(headId);
      throw error;
    }

    return {
      snapshot,
      ref: await this.getHeadStatus(head.id, snapshot),
      head,
    };
  }

  public async persistWorkingEvent(event: SessionEvent): Promise<void> {
    await this.ensureProcessLease();
    await this.sessionStore.appendEvent(event);
  }

  public async persistWorkingSnapshot(
    snapshot: SessionSnapshot,
    status?: SessionWorkingHead["status"],
  ): Promise<void> {
    await this.runRepoMutation(async () => {
      await this.sessionStore.saveSnapshot(snapshot);
      const head = await this.requireHead(snapshot.workingHeadId);
      head.runtimeState = {
        ...head.runtimeState,
        shellCwd: snapshot.shellCwd,
      };
      if (status) {
        head.runtimeState.status = status;
        head.status = status;
      }
      head.updatedAt = new Date().toISOString();
      await this.graphStore.saveHead(head);
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async getPendingApprovalCheckpoint(
    headId?: string,
  ): Promise<PendingApprovalCheckpoint | undefined> {
    const head = await this.getHead(headId);
    return this.sessionStore.loadPendingApprovalCheckpoint(head.id);
  }

  public async savePendingApprovalCheckpoint(
    checkpoint: PendingApprovalCheckpoint,
  ): Promise<void> {
    await this.runRepoMutation(async () => {
      await this.sessionStore.savePendingApprovalCheckpoint(
        checkpoint.headId,
        checkpoint,
      );
      const head = await this.requireHead(checkpoint.headId);
      head.runtimeState.status = "awaiting-approval";
      head.status = "awaiting-approval";
      head.updatedAt = new Date().toISOString();
      await this.graphStore.saveHead(head);
    }, {
      headIds: [checkpoint.headId],
    });
  }

  public async clearPendingApprovalCheckpoint(headId: string): Promise<void> {
    await this.runHeadMutation(headId, async () => {
      await this.sessionStore.clearPendingApprovalCheckpoint(headId);
    });
  }

  public async flushCheckpointIfDirty(
    snapshot: SessionSnapshot,
  ): Promise<boolean> {
    return this.runRepoMutation(async () => {
      const node = await this.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
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
    return this.runRepoMutation(async () => {
      const node = await this.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "compact",
      });
      return Boolean(node);
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async getActiveHead(): Promise<SessionWorkingHead> {
    await this.ensureRepoLoaded();
    return this.requireHead(this.requireRepoState().activeWorkingHeadId);
  }

  public async getHead(headId?: string): Promise<SessionWorkingHead> {
    await this.ensureRepoLoaded();
    return this.requireHead(headId ?? this.requireRepoState().activeWorkingHeadId);
  }

  public async getHeadSnapshot(headId?: string): Promise<SessionSnapshot> {
    const head = await this.getHead(headId);
    return this.loadWorkingSnapshot(head.id);
  }

  public async getHeadStatus(
    headId?: string,
    snapshot?: SessionSnapshot,
  ): Promise<SessionRefInfo> {
    const head = await this.getHead(headId);
    const headSnapshot =
      snapshot && snapshot.workingHeadId === head.id
        ? cloneSnapshotForHead(snapshot, head)
        : await this.loadWorkingSnapshot(head.id);
    const node = await this.requireNode(head.currentNodeId);

    return {
      mode: attachmentModeToRefMode(head.attachment.mode),
      name: head.attachment.name,
      label: attachmentLabel(head.attachment),
      headNodeId: head.currentNodeId,
      workingHeadId: head.id,
      workingHeadName: head.name,
      sessionId: head.sessionId,
      writerLeaseBranch: head.writerLease?.branchName,
      active: head.id === this.requireRepoState().activeWorkingHeadId,
      dirty: snapshotHash(headSnapshot) !== node.snapshotHash,
    };
  }

  public async getStatus(snapshot?: SessionSnapshot): Promise<SessionRefInfo> {
    await this.ensureRepoLoaded();
    const headId = snapshot?.workingHeadId ?? this.requireRepoState().activeWorkingHeadId;
    return this.getHeadStatus(headId, snapshot);
  }

  public async listHeads(snapshot?: SessionSnapshot): Promise<SessionHeadListView> {
    await this.ensureRepoLoaded();
    const items = await Promise.all(
      this.heads
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
      branches: this.branches.map((branch) => ({
        name: branch.name,
        targetNodeId: branch.headNodeId,
        current: status.mode === "branch" && status.name === branch.name,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
      })),
      tags: this.tags.map((tag) => ({
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
    await this.ensureRepoLoaded();
    const status = await this.getStatus(snapshot);

    return {
      commits: [...this.commits]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((commit) => ({
          ...commit,
          current: commit.nodeId === status.headNodeId,
        })),
    };
  }

  public async graphLog(limit = 20): Promise<SessionLogEntry[]> {
    await this.ensureRepoLoaded();
    const nodes = await this.graphStore.listNodes();
    const refsByNode = new Map<string, string[]>();

    for (const branch of this.branches) {
      const refs = refsByNode.get(branch.headNodeId) ?? [];
      refs.push(`branch:${branch.name}`);
      refsByNode.set(branch.headNodeId, refs);
    }

    for (const tag of this.tags) {
      const refs = refsByNode.get(tag.targetNodeId) ?? [];
      refs.push(`tag:${tag.name}`);
      refsByNode.set(tag.targetNodeId, refs);
    }

    for (const head of this.heads) {
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

  public async createCommit(
    message: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionCommitResult> {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new Error("commit message 不能为空。");
    }

    return this.runRepoMutation(async () => {
      const checkpointNode = await this.ensureSnapshotNode(
        snapshot.workingHeadId,
        snapshot,
        {
          force: false,
          kind: "checkpoint",
        },
      );
      const head = await this.requireHead(snapshot.workingHeadId);
      const commit: SessionCommitRecord = {
        id: createId("commit"),
        message: trimmedMessage,
        nodeId: checkpointNode?.id ?? head.currentNodeId,
        headId: head.id,
        sessionId: head.sessionId,
        createdAt: new Date().toISOString(),
      };
      this.commits.push(commit);
      await this.graphStore.saveCommits(this.commits);
      await this.saveRepoMetadata();

      return {
        commit,
        ref: await this.getHeadStatus(head.id, snapshot),
        head,
        message: `已创建 commit ${commit.id}。`,
      };
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async createBranch(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    return this.runRepoMutation(async () => {
      this.assertValidRefName(name, "branch");
      this.assertRefNameAvailable(name);
      await this.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "checkpoint",
      });

      this.branches.push({
        name,
        headNodeId: (await this.requireHead(snapshot.workingHeadId)).currentNodeId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.graphStore.saveBranches(this.branches);

      const head = await this.requireHead(snapshot.workingHeadId);
      return {
        ref: await this.getHeadStatus(head.id, snapshot),
        head,
        message: `已创建分支 ${name}，当前未切换。`,
      };
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async forkBranch(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionHeadForkResult> {
    const nextHeadId = createId("head");
    return this.runRepoMutation(async () => {
      this.assertValidRefName(name, "branch");
      this.assertRefNameAvailable(name);
      await this.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "checkpoint",
      });

      const sourceHead = await this.requireHead(snapshot.workingHeadId);
      this.branches.push({
        name,
        headNodeId: sourceHead.currentNodeId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.graphStore.saveBranches(this.branches);

      return this.forkHeadInternal(
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

  public async createTag(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    return this.runRepoMutation(async () => {
      this.assertValidRefName(name, "tag");
      this.assertRefNameAvailable(name);
      await this.ensureSnapshotNode(snapshot.workingHeadId, snapshot, {
        force: false,
        kind: "checkpoint",
      });

      const head = await this.requireHead(snapshot.workingHeadId);
      this.tags.push({
        name,
        targetNodeId: head.currentNodeId,
        createdAt: new Date().toISOString(),
      });
      await this.graphStore.saveTags(this.tags);

      return {
        ref: await this.getHeadStatus(head.id, snapshot),
        head,
        message: `已创建 tag ${name} -> ${head.currentNodeId}。`,
      };
    }, {
      headIds: [snapshot.workingHeadId],
    });
  }

  public async switchHead(
    headId: string,
    currentSnapshot?: SessionSnapshot,
  ): Promise<SessionHeadSwitchResult> {
    return this.runRepoMutation(async () => {
      const previousHead = await this.getActiveHead();
      if (currentSnapshot && previousHead.id === currentSnapshot.workingHeadId) {
        await this.ensureSnapshotNode(previousHead.id, currentSnapshot, {
          force: false,
          kind: "checkpoint",
        });
      }

      const nextHead = await this.requireHead(headId);
      if (nextHead.status === "closed") {
        throw new Error(`working head 已关闭：${nextHead.name}`);
      }

      this.requireRepoState().activeWorkingHeadId = nextHead.id;
      await this.saveRepoMetadata();
      const snapshot = await this.loadWorkingSnapshot(nextHead.id);
      return {
        snapshot,
        ref: await this.getHeadStatus(nextHead.id, snapshot),
        head: nextHead,
        message: `已切换到 working head ${nextHead.name}。`,
      };
    }, {
      headIds: currentSnapshot ? [currentSnapshot.workingHeadId] : [],
    });
  }

  public async forkHead(
    name: string,
    options: ForkHeadOptions = {},
  ): Promise<SessionHeadForkResult> {
    const headId = createId("head");
    return this.runRepoMutation(() => this.forkHeadInternal(name, options, headId), {
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
    return this.runRepoMutation(async () => {
      if (snapshot && snapshot.workingHeadId === headId) {
        await this.ensureSnapshotNode(headId, snapshot, {
          force: false,
          kind: "checkpoint",
        });
      }

      const head = await this.requireHead(headId);
      const resolved = await this.resolveRef(ref);
      if (resolved.kind === "branch") {
        await this.assertWriterLeaseAvailable(head.id, resolved.ref.name);
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
      await this.sessionStore.saveSnapshot(restoredSnapshot);
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
      await this.graphStore.saveHead(head);

      return {
        snapshot: restoredSnapshot,
        ref: await this.getHeadStatus(head.id, restoredSnapshot),
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

  public async detachHead(headId: string): Promise<SessionMutationResult> {
    return this.runRepoMutation(async () => {
      const head = await this.requireHead(headId);
      head.attachment = {
        mode: "detached-node",
        name: head.currentNodeId,
        nodeId: head.currentNodeId,
      };
      head.writerLease = undefined;
      head.updatedAt = new Date().toISOString();
      await this.graphStore.saveHead(head);
      return {
        ref: await this.getHeadStatus(head.id),
        head,
        message: `已将 working head ${head.name} 置为 detached。`,
      };
    });
  }

  public async closeHead(headId: string): Promise<SessionMutationResult> {
    return this.runRepoMutation(async () => {
      const head = await this.requireHead(headId);
      if (head.id === this.requireRepoState().activeWorkingHeadId) {
        throw new Error("当前 active working head 不能直接关闭。");
      }

      head.status = "closed";
      head.writerLease = undefined;
      head.updatedAt = new Date().toISOString();
      await this.graphStore.saveHead(head);
      return {
        ref: await this.getHeadStatus(this.requireRepoState().activeWorkingHeadId),
        head,
        message: `已关闭 working head ${head.name}。`,
      };
    });
  }

  public async acquireWriterLease(
    headId: string,
    branchName: string,
  ): Promise<SessionMutationResult> {
    return this.runRepoMutation(async () => {
      await this.assertWriterLeaseAvailable(headId, branchName);
      const head = await this.requireHead(headId);
      head.writerLease = {
        branchName,
        acquiredAt: new Date().toISOString(),
      };
      head.updatedAt = new Date().toISOString();
      await this.graphStore.saveHead(head);
      return {
        ref: await this.getHeadStatus(head.id),
        head,
        message: `已为 ${head.name} 获取分支 ${branchName} 的 writer lease。`,
      };
    });
  }

  public async releaseWriterLease(
    headId: string,
  ): Promise<SessionMutationResult> {
    return this.runRepoMutation(async () => {
      const head = await this.requireHead(headId);
      head.writerLease = undefined;
      head.updatedAt = new Date().toISOString();
      await this.graphStore.saveHead(head);
      return {
        ref: await this.getHeadStatus(head.id),
        head,
        message: `已释放 ${head.name} 的 writer lease。`,
      };
    });
  }

  public async updateHeadRuntimeState(
    headId: string,
    patch: Partial<SessionWorkingHead["runtimeState"]>,
  ): Promise<SessionWorkingHead> {
    return this.runRepoMutation(async () => {
      const head = await this.requireHead(headId);
      head.runtimeState = {
        ...head.runtimeState,
        ...patch,
      };
      head.updatedAt = new Date().toISOString();
      await this.graphStore.saveHead(head);
      return head;
    });
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
    return this.runRepoMutation(async () => {
      const head = await this.requireHead(headId);
      if (head.attachment.mode !== "tag") {
        return undefined;
      }
      const tagName = head.attachment.name;

      if (snapshot && snapshot.workingHeadId === head.id) {
        await this.ensureSnapshotNode(head.id, snapshot, {
          force: true,
          kind: "checkpoint",
        });
      }
      const refreshedHead = await this.requireHead(head.id);
      const branchName = await this.ensureUniqueBranchName(
        `from-tag-${tagName}-${formatUtcTimestamp()}`,
      );
      const now = new Date().toISOString();
      this.branches.push({
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
      await this.saveRepoMetadata();
      await this.graphStore.saveHead(refreshedHead);

      return {
        ref: await this.getHeadStatus(refreshedHead.id),
        head: refreshedHead,
        message: `已从 tag ${tagName} 自动创建并切换到分支 ${branchName}。`,
      };
    }, {
      headIds: [headId],
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
    return this.runRepoMutation(async () => {
      if (targetSnapshot && targetSnapshot.workingHeadId === targetHeadId) {
        await this.ensureSnapshotNode(targetHeadId, targetSnapshot, {
          force: false,
          kind: "checkpoint",
        });
      }

      const targetHead = await this.requireHead(targetHeadId);
      const sourceHead = await this.requireHead(sourceHeadId);
      if (targetHead.id === sourceHead.id) {
        throw new Error("sourceHead 与 targetHead 相同，无法 merge。");
      }

      return this.mergeResolvedSourceIntoHead(targetHead, sourceHead, assets);
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
    return this.runRepoMutation(async () => {
      if (targetSnapshot && targetSnapshot.workingHeadId === targetHeadId) {
        await this.ensureSnapshotNode(targetHeadId, targetSnapshot, {
          force: false,
          kind: "checkpoint",
        });
      }

      const targetHead = await this.requireHead(targetHeadId);
      const resolved = await this.resolveRef(sourceRef);
      if (resolved.node.id === targetHead.currentNodeId) {
        throw new Error("sourceRef 与当前 head 相同，无法 merge。");
      }

      const sourceHead =
        resolved.kind === "node"
          ? this.buildSyntheticSourceHead(resolved.node)
          : this.findAttachedHeadForRef(sourceRef, resolved.node.id)
            ?? this.buildSyntheticSourceHead(resolved.node, sourceRef);

      return this.mergeResolvedSourceIntoHead(targetHead, sourceHead, assets);
    }, {
      headIds: targetSnapshot ? [targetHeadId] : [],
    });
  }

  private async forkHeadInternal(
    name: string,
    options: ForkHeadOptions,
    headId: string,
  ): Promise<SessionHeadForkResult> {
    this.assertHeadNameAvailable(name);
    const sourceHead =
      options.sourceHeadId
        ? await this.requireHead(options.sourceHeadId)
        : await this.getActiveHead();
    const sourceSnapshot = await this.loadWorkingSnapshot(sourceHead.id);
    const now = new Date().toISOString();
    const head: SessionWorkingHead = {
      id: headId,
      name,
      currentNodeId: sourceHead.currentNodeId,
      sessionId: createId("session"),
      attachment:
        options.attachment ?? {
          mode: "detached-node",
          name: sourceHead.currentNodeId,
          nodeId: sourceHead.currentNodeId,
        },
      writerLease: undefined,
      runtimeState: {
        shellCwd: sourceSnapshot.shellCwd,
        agentKind: options.runtimeState?.agentKind
          ?? sourceHead.runtimeState.agentKind
          ?? "interactive",
        autoMemoryFork: options.runtimeState?.autoMemoryFork
          ?? sourceHead.runtimeState.autoMemoryFork
          ?? true,
        retainOnCompletion: options.runtimeState?.retainOnCompletion
          ?? sourceHead.runtimeState.retainOnCompletion
          ?? true,
        promptProfile: options.runtimeState?.promptProfile
          ?? sourceHead.runtimeState.promptProfile
          ?? "default",
        toolMode: options.runtimeState?.toolMode
          ?? sourceHead.runtimeState.toolMode
          ?? "shell",
        uiContextEnabled: options.runtimeState?.uiContextEnabled
          ?? sourceHead.runtimeState.uiContextEnabled
          ?? false,
        status: "idle",
      },
      assetState: {},
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    const previousActiveWorkingHeadId = this.requireRepoState().activeWorkingHeadId;
    const snapshot = cloneSnapshotForHead(sourceSnapshot, head);
    await this.sessionStore.saveSnapshot(snapshot);
    try {
      head.assetState = await this.runForkProviders(head, snapshot, sourceHead);
      if (options.acquireWriterLease && head.attachment.mode === "branch") {
        await this.assertWriterLeaseAvailable(head.id, head.attachment.name);
        head.writerLease = {
          branchName: head.attachment.name,
          acquiredAt: now,
        };
      }
      this.heads.push(head);
      await this.graphStore.saveHead(head);
      if (options.activate) {
        this.requireRepoState().activeWorkingHeadId = head.id;
        await this.saveRepoMetadata();
      }

      return {
        snapshot,
        ref: await this.getHeadStatus(head.id, snapshot),
        head,
        message: `已创建 working head ${name}。`,
      };
    } catch (error) {
      await this.rollbackForkHeadFailure(headId, previousActiveWorkingHeadId);
      throw error;
    }
  }

  private async mergeResolvedSourceIntoHead(
    targetHead: SessionWorkingHead,
    sourceHead: SessionWorkingHead,
    assets: string[],
  ): Promise<SessionMutationResult> {
    const targetNode = await this.requireNode(targetHead.currentNodeId);
    const sourceNode = await this.requireNode(sourceHead.currentNodeId);
    const targetSnapshot = await this.loadWorkingSnapshot(targetHead.id);
    const sourceSnapshot =
      sourceHead.id.startsWith("synthetic:")
        ? cloneSnapshotForHead(sourceNode.snapshot, sourceHead)
        : await this.loadWorkingSnapshot(sourceHead.id);

    const mergeAssets: SessionAbstractAsset[] = [];
    let nextAssetState = {
      ...targetHead.assetState,
    };
    for (const provider of this.assetProviders) {
      if (!assets.includes(provider.kind)) {
        continue;
      }
      const merged = await provider.merge({
        targetHead,
        sourceHead,
        targetState: targetHead.assetState[provider.kind],
        sourceState: sourceHead.assetState[provider.kind],
        targetSnapshot,
        sourceSnapshot,
        sessionRoot: this.sessionRoot,
      });
      nextAssetState = {
        ...nextAssetState,
        [provider.kind]: merged.targetState,
      };
      mergeAssets.push(...(merged.mergeAssets ?? []));
    }

    const nextAbstractAssets = assets.includes("digest")
      ? dedupeAssets([
          ...targetNode.abstractAssets,
          ...sourceNode.abstractAssets,
          ...mergeAssets,
        ])
      : dedupeAssets([...targetNode.abstractAssets, ...mergeAssets]);
    const mergeNode: SessionNode = {
      id: createId("node"),
      parentNodeIds: [targetNode.id, sourceNode.id],
      kind: "merge",
      snapshot: cloneSnapshotForHead(targetSnapshot, targetHead),
      abstractAssets: nextAbstractAssets,
      snapshotHash: targetNode.snapshotHash,
      createdAt: new Date().toISOString(),
    };
    await this.graphStore.saveNode(mergeNode);
    targetHead.currentNodeId = mergeNode.id;
    targetHead.assetState = nextAssetState;
    if (targetHead.attachment.mode === "branch") {
      targetHead.attachment = {
        ...targetHead.attachment,
        nodeId: mergeNode.id,
      };
      if (targetHead.writerLease?.branchName === targetHead.attachment.name) {
        this.updateBranchHead(targetHead.attachment.name, mergeNode.id);
      }
    } else {
      targetHead.attachment = {
        mode: "detached-node",
        name: mergeNode.id,
        nodeId: mergeNode.id,
      };
      targetHead.writerLease = undefined;
    }
    targetHead.updatedAt = new Date().toISOString();
    await this.graphStore.saveHead(targetHead);
    await this.saveRepoMetadata();

    return {
      ref: await this.getHeadStatus(targetHead.id),
      head: targetHead,
      message: `已将 ${sourceHead.name} merge 到 ${targetHead.name}。`,
    };
  }

  private buildSyntheticSourceHead(
    node: SessionNode,
    name = `node:${node.id}`,
  ): SessionWorkingHead {
    return {
      id: `synthetic:${name}`,
      name,
      currentNodeId: node.id,
      sessionId: `synthetic:${node.id}`,
      attachment: {
        mode: "detached-node",
        name: node.id,
        nodeId: node.id,
      },
      runtimeState: {
        shellCwd: node.snapshot.shellCwd,
        promptProfile: "default",
        toolMode: "shell",
        uiContextEnabled: false,
      },
      assetState: {},
      status: "idle",
      createdAt: node.createdAt,
      updatedAt: node.createdAt,
    };
  }

  private findAttachedHeadForRef(
    ref: string,
    nodeId: string,
  ): SessionWorkingHead | undefined {
    return this.heads.find((head) => {
      if (head.status === "closed") {
        return false;
      }
      return head.currentNodeId === nodeId && head.attachment.name === ref;
    });
  }

  private async runForkProviders(
    head: SessionWorkingHead,
    snapshot: SessionSnapshot,
    sourceHead?: SessionWorkingHead,
  ): Promise<Record<string, unknown>> {
    return this.assetOverlayService.runForkProviders(head, snapshot, sourceHead);
  }

  private async runCheckpointProviders(
    head: SessionWorkingHead,
    snapshot: SessionSnapshot,
  ): Promise<Record<string, unknown>> {
    return this.assetOverlayService.runCheckpointProviders(head, snapshot);
  }

  private async restoreProviders(head: SessionWorkingHead): Promise<void> {
    await this.assetOverlayService.restoreProviders(head);
  }

  private async loadWorkingSnapshot(headId: string): Promise<SessionSnapshot> {
    return this.assetOverlayService.loadWorkingSnapshot(headId);
  }

  private async ensureProcessLease(): Promise<void> {
    await this.lockService.ensureProcessLease();
  }

  private async runRepoMutation<T>(
    action: () => Promise<T>,
    input?: {
      headIds?: string[];
      reloadRepo?: boolean;
    },
  ): Promise<T> {
    await this.ensureProcessLease();
    const repoLock = await this.lockService.acquireRepoMutationLock();
    const headLocks = await this.acquireHeadLocks(input?.headIds);
    try {
      if (input?.reloadRepo !== false) {
        await this.loadRepo();
      }
      return await action();
    } finally {
      await this.releaseLocks(headLocks);
      await repoLock.release();
    }
  }

  private async runHeadMutation<T>(
    headId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await this.ensureProcessLease();
    const lock = await this.lockService.acquireHeadMutationLock(headId);
    try {
      return await action();
    } finally {
      await lock.release();
    }
  }

  private async acquireHeadLocks(
    headIds: ReadonlyArray<string> | undefined,
  ): Promise<SessionLockHandle[]> {
    const uniqueHeadIds = [...new Set((headIds ?? []).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    const locks: SessionLockHandle[] = [];
    for (const headId of uniqueHeadIds) {
      locks.push(await this.lockService.acquireHeadMutationLock(headId));
    }
    return locks;
  }

  private async releaseLocks(
    locks: ReadonlyArray<SessionLockHandle>,
  ): Promise<void> {
    for (const lock of [...locks].reverse()) {
      await lock.release();
    }
  }

  private async ensureRepoLoaded(): Promise<void> {
    await this.ensureProcessLease();
    if (this.repoState) {
      return;
    }
    await this.loadRepo();
  }

  private async loadRepo(): Promise<void> {
    const loadedState = await this.graphStore.loadState() as
      | SessionRepoState
      | LegacySessionRepoStateV1
      | undefined;
    if (!loadedState) {
      throw new Error("Session repo 不存在或已损坏。");
    }
    if ((loadedState as { version?: number }).version !== 2) {
      if (!isLegacyRepoState(loadedState)) {
        throw new Error(V1_INCOMPATIBLE_MESSAGE);
      }
      this.lastLoadInfoMessage = await this.migrateLegacyRepo(loadedState);
    }
    this.repoState = await this.graphStore.loadState();
    if (!this.repoState || (this.repoState as { version?: number }).version !== 2) {
      throw new Error(V1_INCOMPATIBLE_MESSAGE);
    }
    this.branches = await this.graphStore.loadBranches();
    this.tags = await this.graphStore.loadTags();
    this.commits = await this.graphStore.loadCommits();
    this.heads = await this.graphStore.listHeads();
  }

  private async migrateLegacyRepo(state: LegacySessionRepoStateV1): Promise<string> {
    const migrated = await this.repoMigrationService.migrateLegacyRepo(state);
    this.repoState = migrated.repoState;
    this.branches = migrated.branches;
    this.tags = migrated.tags;
    this.heads = migrated.heads;
    return migrated.infoMessage;
  }

  private requireRepoState(): SessionRepoState {
    if (!this.repoState) {
      throw new Error("Session repo 尚未加载。");
    }
    return this.repoState;
  }

  private async requireHead(headId: string): Promise<SessionWorkingHead> {
    const head = this.heads.find((item) => item.id === headId);
    if (!head) {
      throw new Error(`未找到 working head：${headId}`);
    }
    return head;
  }

  private async requireNode(nodeId: string): Promise<SessionNode> {
    const node = await this.graphStore.loadNode(nodeId);
    if (!node) {
      throw new Error(`未找到 session node：${nodeId}`);
    }
    return node;
  }

  private async ensureSnapshotNode(
    headId: string,
    snapshot: SessionSnapshot,
    input: {
      force: boolean;
      kind: "checkpoint" | "compact";
    },
  ): Promise<SessionNode | undefined> {
    await this.ensureRepoLoaded();
    const head = await this.requireHead(headId);
    const currentSnapshot = cloneSnapshotForHead(snapshot, head);
    const currentHash = snapshotHash(currentSnapshot);
    const currentNode = await this.requireNode(head.currentNodeId);
    if (!input.force && currentHash === currentNode.snapshotHash) {
      return undefined;
    }

    const nextAssetState = await this.runCheckpointProviders(head, currentSnapshot);
    const checkpointNode = this.buildNode({
      kind: input.kind,
      parentNodeIds: [currentNode.id],
      snapshot: currentSnapshot,
      assetState: nextAssetState,
    });
    await this.graphStore.saveNode(checkpointNode);

    head.currentNodeId = checkpointNode.id;
    head.assetState = nextAssetState;
    head.runtimeState.shellCwd = currentSnapshot.shellCwd;
    if (head.attachment.mode === "branch") {
      head.attachment = {
        ...head.attachment,
        nodeId: checkpointNode.id,
      };
      if (head.writerLease?.branchName === head.attachment.name) {
        this.updateBranchHead(head.attachment.name, checkpointNode.id);
      }
    } else {
      head.attachment = {
        mode: "detached-node",
        name: checkpointNode.id,
        nodeId: checkpointNode.id,
      };
      head.writerLease = undefined;
    }
    head.updatedAt = new Date().toISOString();
    await this.graphStore.saveHead(head);
    await this.sessionStore.saveSnapshot(currentSnapshot);
    await this.saveRepoMetadata();
    return checkpointNode;
  }

  private buildNode(input: {
    kind: SessionNode["kind"];
    parentNodeIds: string[];
    snapshot: SessionSnapshot;
    assetState: Record<string, unknown>;
  }): SessionNode {
    const nodeId = createId("node");
    const snapshot = {
      ...input.snapshot,
      updatedAt: new Date().toISOString(),
    };
    const digestState = input.assetState.digest as
      | {
          user: string;
          assistant: string;
          tool: string;
        }
      | undefined;
    const digestAsset =
      input.kind === "merge" || !digestState
        ? undefined
        : buildNodeDigestAsset(
            input.kind,
            nodeId,
            {
              ...digestState,
              updatedAt: new Date().toISOString(),
            },
            input.parentNodeIds.length > 0 ? input.parentNodeIds : [nodeId],
          );

    return {
      id: nodeId,
      parentNodeIds: input.parentNodeIds,
      kind: input.kind,
      snapshot,
      abstractAssets: dedupeAssets(digestAsset ? [digestAsset] : []),
      snapshotHash: snapshotHash(snapshot),
      createdAt: new Date().toISOString(),
    };
  }

  private async resolveRef(ref: string): Promise<
    | { kind: "branch"; ref: SessionBranchRef; node: SessionNode }
    | { kind: "tag"; ref: SessionTagRef; node: SessionNode }
    | { kind: "commit"; commit: SessionCommitRecord; node: SessionNode }
    | { kind: "node"; node: SessionNode }
  > {
    const branch = this.branches.find((item) => item.name === ref);
    if (branch) {
      return {
        kind: "branch",
        ref: branch,
        node: await this.requireNode(branch.headNodeId),
      };
    }

    const tag = this.tags.find((item) => item.name === ref);
    if (tag) {
      return {
        kind: "tag",
        ref: tag,
        node: await this.requireNode(tag.targetNodeId),
      };
    }

    const commit = this.commits.find((item) => item.id === ref);
    if (commit) {
      return {
        kind: "commit",
        commit,
        node: await this.requireNode(commit.nodeId),
      };
    }

    const node = await this.graphStore.loadNode(ref);
    if (node) {
      return {
        kind: "node",
        node,
      };
    }

    throw new Error(`未找到 session ref：${ref}`);
  }

  private assertValidRefName(name: string, kind: "branch" | "tag"): void {
    if (!SESSION_REF_NAME_PATTERN.test(name)) {
      throw new Error(
        `${kind} 名称必须匹配 ${SESSION_REF_NAME_PATTERN.toString()}。`,
      );
    }
  }

  private assertRefNameAvailable(name: string): void {
    if (this.branches.some((branch) => branch.name === name)) {
      throw new Error(`分支已存在：${name}`);
    }
    if (this.tags.some((tag) => tag.name === name)) {
      throw new Error(`tag 已存在：${name}`);
    }
  }

  private async assertWriterLeaseAvailable(
    headId: string,
    branchName: string,
  ): Promise<void> {
    const owner = this.heads.find((head) => {
      return (
        head.id !== headId &&
        head.status !== "closed" &&
        head.writerLease?.branchName === branchName
      );
    });
    if (owner) {
      throw new Error(
        `分支 ${branchName} 当前由 working head ${owner.name} 持有 writer lease。`,
      );
    }
  }

  private assertHeadNameAvailable(name: string): void {
    if (this.heads.some((head) => head.status !== "closed" && head.name === name)) {
      throw new Error(`working head 已存在：${name}`);
    }
  }

  private updateBranchHead(branchName: string, headNodeId: string): void {
    this.branches = this.branches.map((branch) => {
      if (branch.name !== branchName) {
        return branch;
      }
      return {
        ...branch,
        headNodeId,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private async ensureUniqueBranchName(baseName: string): Promise<string> {
    let candidate = baseName;
    let counter = 1;
    while (this.branches.some((branch) => branch.name === candidate)) {
      candidate = `${baseName}-${counter}`;
      counter += 1;
    }
    return candidate;
  }

  private async saveRepoMetadata(): Promise<void> {
    this.requireRepoState().updatedAt = new Date().toISOString();
    await Promise.all([
      this.graphStore.saveState(this.requireRepoState()),
      this.graphStore.saveBranches(this.branches),
      this.graphStore.saveTags(this.tags),
    ]);
  }

  private async rollbackInitializationFailure(headId: string): Promise<void> {
    this.repoState = undefined;
    this.branches = [];
    this.tags = [];
    this.commits = [];
    this.heads = [];
    this.lastLoadInfoMessage = undefined;

    await Promise.all([
      rm(path.join(this.sessionRoot, "__repo"), {
        recursive: true,
        force: true,
      }),
      rm(path.join(this.sessionRoot, "__heads", headId), {
        recursive: true,
        force: true,
      }),
    ]);
  }

  private async rollbackForkHeadFailure(
    headId: string,
    previousActiveWorkingHeadId: string,
  ): Promise<void> {
    this.heads = this.heads.filter((head) => head.id !== headId);
    if (this.repoState) {
      this.repoState.activeWorkingHeadId = previousActiveWorkingHeadId;
    }

    await Promise.all([
      rm(path.join(this.sessionRoot, "__heads", headId), {
        recursive: true,
        force: true,
      }),
      rm(path.join(this.sessionRoot, "__repo", "heads", `${headId}.json`), {
        force: true,
      }),
    ]);

    if (this.repoState) {
      await this.saveRepoMetadata();
    }
  }
}
