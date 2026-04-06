import { createHash } from "node:crypto";

import type {
  ApprovalMode,
  SessionAbstractAsset,
  SessionBranchRef,
  SessionEvent,
  SessionListView,
  SessionLogEntry,
  SessionNode,
  SessionRefInfo,
  SessionRepoState,
  SessionSnapshot,
  SessionTagRef,
} from "../types.js";
import { createId, firstLine, truncate } from "../utils/index.js";
import { SessionGraphStore } from "./sessionGraphStore.js";
import { SessionStore } from "./sessionStore.js";

interface SessionInitializationInput {
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
  resumeSessionId?: string;
}

export interface SessionInitializationResult {
  snapshot: SessionSnapshot;
  ref: SessionRefInfo;
  infoMessage?: string;
}

export interface SessionMutationResult {
  ref: SessionRefInfo;
  message: string;
}

export interface SessionCheckoutResult extends SessionMutationResult {
  snapshot: SessionSnapshot;
}

const DEFAULT_BRANCH_NAME = "main" as const;
const SESSION_REF_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function cloneSnapshot(
  snapshot: SessionSnapshot,
  sessionId: string,
): SessionSnapshot {
  return {
    ...snapshot,
    sessionId,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSnapshotForHash(
  snapshot: SessionSnapshot,
): Record<string, unknown> {
  return {
    cwd: snapshot.cwd,
    shellCwd: snapshot.shellCwd,
    approvalMode: snapshot.approvalMode,
    modelMessages: snapshot.modelMessages,
    lastUserPrompt: snapshot.lastUserPrompt ?? "",
    lastRunSummary: snapshot.lastRunSummary ?? "",
  };
}

function snapshotHash(snapshot: SessionSnapshot): string {
  return createHash("sha1")
    .update(JSON.stringify(normalizeSnapshotForHash(snapshot)))
    .digest("hex");
}

function summaryContentFromSnapshot(snapshot: SessionSnapshot): {
  user: string;
  assistant: string;
  tool: string;
} {
  const lastAssistant = [...snapshot.modelMessages]
    .reverse()
    .find((message) => {
      return message.role === "assistant" && message.content.trim().length > 0;
    });
  const lastTool = [...snapshot.modelMessages]
    .reverse()
    .find((message) => message.role === "tool");

  return {
    user: firstLine(snapshot.lastUserPrompt ?? "", "无"),
    assistant:
      firstLine(
        lastAssistant?.content ?? "",
        "无",
      ),
    tool: firstLine(lastTool?.content ?? "", "无"),
  };
}

function buildNodeSummaryAsset(
  kind: SessionNode["kind"],
  nodeId: string,
  snapshot: SessionSnapshot,
  sourceNodeIds: string[],
): SessionAbstractAsset {
  const summary = summaryContentFromSnapshot(snapshot);
  return {
    id: createId("asset"),
    title: `${kind}:${nodeId}`,
    content: [
      `user: ${summary.user}`,
      `assistant: ${truncate(summary.assistant, 160)}`,
      `shell: ${truncate(summary.tool, 160)}`,
    ].join("\n"),
    tags: [kind, "summary"],
    sourceNodeIds,
    createdAt: new Date().toISOString(),
  };
}

function buildMergeSummaryAsset(
  nodeId: string,
  sourceRef: string,
  currentSummary: string,
  sourceSummary: string,
  sourceNodeIds: string[],
): SessionAbstractAsset {
  return {
    id: createId("asset"),
    title: `merge:${sourceRef}`,
    content: [
      `merged_at: ${new Date().toISOString()}`,
      `current: ${currentSummary || "无"}`,
      `source: ${sourceSummary || "无"}`,
    ].join("\n"),
    tags: ["merge", "summary"],
    sourceNodeIds,
    createdAt: new Date().toISOString(),
  };
}

function dedupeAssets(assets: SessionAbstractAsset[]): SessionAbstractAsset[] {
  const seen = new Set<string>();
  const deduped: SessionAbstractAsset[] = [];

  for (const asset of assets) {
    const key = `${asset.title}\n${asset.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(asset);
  }

  return deduped;
}

function formatUtcTimestamp(value = new Date()): string {
  return value
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "")
    .toLowerCase();
}

export class SessionService {
  private readonly sessionStore: SessionStore;
  private readonly graphStore: SessionGraphStore;
  private repoState?: SessionRepoState;
  private branches: SessionBranchRef[] = [];
  private tags: SessionTagRef[] = [];

  public constructor(private readonly sessionRoot: string) {
    this.sessionStore = new SessionStore(sessionRoot);
    this.graphStore = new SessionGraphStore(sessionRoot);
  }

  public async initialize(
    input: SessionInitializationInput,
  ): Promise<SessionInitializationResult> {
    if (await this.graphStore.repoExists()) {
      await this.loadRepo();

      if (input.resumeSessionId && input.resumeSessionId !== "latest") {
        const exact = await this.sessionStore.load(input.resumeSessionId);
        if (!exact) {
          throw new Error(`未找到会话：${input.resumeSessionId}`);
        }
        return this.importLegacySnapshotAsDetached(exact);
      }

      const snapshot = await this.loadCurrentWorkingSnapshot();
      return {
        snapshot,
        ref: await this.getStatus(snapshot),
      };
    }

    const imported = await this.resolveLegacySnapshot(input.resumeSessionId);
    const snapshot =
      imported ??
      (await this.sessionStore.initializeSession({
        sessionId: undefined,
        cwd: input.cwd,
        shellCwd: input.shellCwd,
        approvalMode: input.approvalMode,
      }));
    const rootNode = this.buildNode({
      kind: "root",
      parentNodeIds: [],
      snapshot,
      workingSessionId: snapshot.sessionId,
      abstractAssets: [],
    });
    const now = new Date().toISOString();
    const mainBranch: SessionBranchRef = {
      name: DEFAULT_BRANCH_NAME,
      headNodeId: rootNode.id,
      createdAt: now,
      updatedAt: now,
    };
    this.repoState = {
      version: 1,
      currentBranchName: DEFAULT_BRANCH_NAME,
      headNodeId: rootNode.id,
      workingSessionId: snapshot.sessionId,
      defaultBranchName: DEFAULT_BRANCH_NAME,
    };
    this.branches = [mainBranch];
    this.tags = [];
    await this.graphStore.initializeRepo({
      state: this.repoState,
      branches: this.branches,
      tags: this.tags,
      nodes: [rootNode],
    });

    return {
      snapshot,
      ref: await this.getStatus(snapshot),
      infoMessage: imported
        ? `已导入 legacy session ${snapshot.sessionId} 到 main 分支。`
        : undefined,
    };
  }

  public async persistWorkingEvent(event: SessionEvent): Promise<void> {
    await this.sessionStore.appendEvent(event);
  }

  public async persistWorkingSnapshot(snapshot: SessionSnapshot): Promise<void> {
    await this.ensureRepoLoaded();
    if (!this.repoState) {
      throw new Error("Session repo 尚未初始化。");
    }
    if (snapshot.sessionId !== this.repoState.workingSessionId) {
      this.repoState.workingSessionId = snapshot.sessionId;
      await this.graphStore.saveState(this.repoState);
    }
    await this.sessionStore.saveSnapshot(snapshot);
  }

  public async flushCheckpointIfDirty(
    snapshot: SessionSnapshot,
  ): Promise<boolean> {
    const node = await this.ensureCheckpoint(snapshot, false);
    return Boolean(node);
  }

  public async flushCheckpointOnExit(
    snapshot: SessionSnapshot,
  ): Promise<boolean> {
    return this.flushCheckpointIfDirty(snapshot);
  }

  public async prepareForUserInput(
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult | undefined> {
    await this.ensureRepoLoaded();
    const tagName = this.repoState?.detachedTagName;
    if (!tagName) {
      return undefined;
    }

    await this.ensureCheckpoint(snapshot, true);
    const branchName = await this.ensureUniqueBranchName(
      `from-tag-${tagName}-${formatUtcTimestamp()}`,
    );
    const now = new Date().toISOString();
    const repoState = this.requireRepoState();
    this.branches.push({
      name: branchName,
      headNodeId: repoState.headNodeId,
      createdAt: now,
      updatedAt: now,
    });
    repoState.currentBranchName = branchName;
    repoState.detachedTagName = undefined;
    repoState.detachedNodeId = undefined;
    await this.saveRepoMetadata();

    return {
      ref: await this.getStatus(snapshot),
      message: `已从 tag ${tagName} 自动创建并切换到分支 ${branchName}。`,
    };
  }

  public async getStatus(
    snapshot?: SessionSnapshot,
  ): Promise<SessionRefInfo> {
    await this.ensureRepoLoaded();
    if (!this.repoState) {
      throw new Error("Session repo 尚未初始化。");
    }
    const currentSnapshot = snapshot ?? (await this.loadCurrentWorkingSnapshot());
    const headNode = await this.requireNode(this.repoState.headNodeId);
    const dirty = snapshotHash(currentSnapshot) !== headNode.snapshotHash;

    if (this.repoState.currentBranchName) {
      return {
        mode: "branch",
        name: this.repoState.currentBranchName,
        label: `branch=${this.repoState.currentBranchName}`,
        headNodeId: this.repoState.headNodeId,
        workingSessionId: this.repoState.workingSessionId,
        dirty,
      };
    }

    if (this.repoState.detachedTagName) {
      return {
        mode: "detached-tag",
        name: this.repoState.detachedTagName,
        label: `detached=tag:${this.repoState.detachedTagName}`,
        headNodeId: this.repoState.headNodeId,
        workingSessionId: this.repoState.workingSessionId,
        dirty,
      };
    }

    return {
      mode: "detached-node",
      name: this.repoState.detachedNodeId ?? this.repoState.headNodeId,
      label: `detached=node:${this.repoState.detachedNodeId ?? this.repoState.headNodeId}`,
      headNodeId: this.repoState.headNodeId,
      workingSessionId: this.repoState.workingSessionId,
      dirty,
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

  public async log(limit = 20): Promise<SessionLogEntry[]> {
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

  public async createBranch(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    await this.ensureRepoLoaded();
    this.assertValidRefName(name, "branch");
    this.assertRefNameAvailable(name);
    await this.ensureCheckpoint(snapshot, false);

    const now = new Date().toISOString();
    this.branches.push({
      name,
      headNodeId: this.requireRepoState().headNodeId,
      createdAt: now,
      updatedAt: now,
    });
    await this.graphStore.saveBranches(this.branches);

    return {
      ref: await this.getStatus(snapshot),
      message: `已创建分支 ${name}，当前未切换。`,
    };
  }

  public async forkBranch(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    await this.ensureRepoLoaded();
    this.assertValidRefName(name, "branch");
    this.assertRefNameAvailable(name);
    await this.ensureCheckpoint(snapshot, false);

    const now = new Date().toISOString();
    this.branches.push({
      name,
      headNodeId: this.requireRepoState().headNodeId,
      createdAt: now,
      updatedAt: now,
    });
    this.requireRepoState().currentBranchName = name;
    this.requireRepoState().detachedTagName = undefined;
    this.requireRepoState().detachedNodeId = undefined;
    await this.saveRepoMetadata();

    return {
      ref: await this.getStatus(snapshot),
      message: `已创建并切换到分支 ${name}。`,
    };
  }

  public async createTag(
    name: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    await this.ensureRepoLoaded();
    this.assertValidRefName(name, "tag");
    this.assertRefNameAvailable(name);
    await this.ensureCheckpoint(snapshot, false);

    this.tags.push({
      name,
      targetNodeId: this.requireRepoState().headNodeId,
      createdAt: new Date().toISOString(),
    });
    await this.graphStore.saveTags(this.tags);

    return {
      ref: await this.getStatus(snapshot),
      message: `已创建 tag ${name} -> ${this.requireRepoState().headNodeId}。`,
    };
  }

  public async checkout(
    ref: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionCheckoutResult> {
    await this.ensureRepoLoaded();
    await this.ensureCheckpoint(snapshot, false);

    const resolved = await this.resolveRef(ref);
    const workingSessionId = this.requireRepoState().workingSessionId;
    const restoredSnapshot = cloneSnapshot(resolved.node.snapshot, workingSessionId);
    await this.sessionStore.saveSnapshot(restoredSnapshot);

    if (resolved.kind === "branch") {
      this.requireRepoState().currentBranchName = resolved.ref.name;
      this.requireRepoState().detachedTagName = undefined;
      this.requireRepoState().detachedNodeId = undefined;
      this.requireRepoState().headNodeId = resolved.node.id;
    } else if (resolved.kind === "tag") {
      this.requireRepoState().currentBranchName = undefined;
      this.requireRepoState().detachedTagName = resolved.ref.name;
      this.requireRepoState().detachedNodeId = undefined;
      this.requireRepoState().headNodeId = resolved.node.id;
    } else {
      this.requireRepoState().currentBranchName = undefined;
      this.requireRepoState().detachedTagName = undefined;
      this.requireRepoState().detachedNodeId = resolved.node.id;
      this.requireRepoState().headNodeId = resolved.node.id;
    }
    await this.graphStore.saveState(this.requireRepoState());

    const nextStatus = await this.getStatus(restoredSnapshot);
    return {
      snapshot: restoredSnapshot,
      ref: nextStatus,
      message: [
        `已切换到 ${nextStatus.label}。`,
        `working session: ${workingSessionId}`,
        "工作区未自动回退。",
      ].join("\n"),
    };
  }

  public async merge(
    sourceRef: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionMutationResult> {
    await this.ensureRepoLoaded();
    if (!this.requireRepoState().currentBranchName) {
      throw new Error("当前不在分支上，无法执行 merge。");
    }

    await this.ensureCheckpoint(snapshot, false);
    const currentHead = await this.requireNode(this.requireRepoState().headNodeId);
    const resolved = await this.resolveRef(sourceRef);
    if (resolved.node.id === currentHead.id) {
      throw new Error("sourceRef 与当前 head 相同，无法 merge。");
    }

    const mergeNodeId = createId("node");
    const currentSummary = currentHead.abstractAssets[0]?.content ?? "";
    const sourceSummary = resolved.node.abstractAssets[0]?.content ?? "";
    const abstractAssets = dedupeAssets([
      ...currentHead.abstractAssets,
      ...resolved.node.abstractAssets,
      buildMergeSummaryAsset(
        mergeNodeId,
        sourceRef,
        currentSummary,
        sourceSummary,
        [currentHead.id, resolved.node.id],
      ),
    ]);
    const mergeNode: SessionNode = {
      id: mergeNodeId,
      parentNodeIds: [currentHead.id, resolved.node.id],
      kind: "merge",
      workingSessionId: this.requireRepoState().workingSessionId,
      snapshot: cloneSnapshot(currentHead.snapshot, this.requireRepoState().workingSessionId),
      abstractAssets,
      snapshotHash: currentHead.snapshotHash,
      createdAt: new Date().toISOString(),
    };
    await this.graphStore.saveNode(mergeNode);
    this.requireRepoState().headNodeId = mergeNode.id;
    this.updateBranchHead(this.requireRepoState().currentBranchName, mergeNode.id);
    await this.saveRepoMetadata();

    return {
      ref: await this.getStatus(mergeNode.snapshot),
      message: `已将 ${sourceRef} merge 到当前分支，新的 head 是 ${mergeNode.id}。`,
    };
  }

  private async importLegacySnapshotAsDetached(
    snapshot: SessionSnapshot,
  ): Promise<SessionInitializationResult> {
    const importedNode = this.buildNode({
      kind: "root",
      parentNodeIds: [],
      snapshot,
      workingSessionId: snapshot.sessionId,
      abstractAssets: [],
    });
    await this.graphStore.saveNode(importedNode);
    this.requireRepoState().currentBranchName = undefined;
    this.requireRepoState().detachedTagName = undefined;
    this.requireRepoState().detachedNodeId = importedNode.id;
    this.requireRepoState().headNodeId = importedNode.id;
    this.requireRepoState().workingSessionId = snapshot.sessionId;
    await this.graphStore.saveState(this.requireRepoState());
    await this.sessionStore.saveSnapshot(snapshot);

    return {
      snapshot,
      ref: await this.getStatus(snapshot),
      infoMessage: `已导入 legacy session ${snapshot.sessionId} 并进入 detached 状态。`,
    };
  }

  private async resolveLegacySnapshot(
    resumeSessionId?: string,
  ): Promise<SessionSnapshot | undefined> {
    if (resumeSessionId && resumeSessionId !== "latest") {
      const exact = await this.sessionStore.load(resumeSessionId);
      if (!exact) {
        throw new Error(`未找到会话：${resumeSessionId}`);
      }
      return exact;
    }

    return this.sessionStore.loadMostRecent();
  }

  private async loadCurrentWorkingSnapshot(): Promise<SessionSnapshot> {
    await this.ensureRepoLoaded();
    const current = await this.sessionStore.load(this.requireRepoState().workingSessionId);
    if (current) {
      return current;
    }

    const headNode = await this.requireNode(this.requireRepoState().headNodeId);
    const restored = cloneSnapshot(
      headNode.snapshot,
      this.requireRepoState().workingSessionId,
    );
    await this.sessionStore.saveSnapshot(restored);
    return restored;
  }

  private async ensureRepoLoaded(): Promise<void> {
    if (this.repoState) {
      return;
    }

    await this.loadRepo();
  }

  private async loadRepo(): Promise<void> {
    this.repoState = await this.graphStore.loadState();
    if (!this.repoState) {
      throw new Error("Session repo 不存在或已损坏。");
    }
    this.branches = await this.graphStore.loadBranches();
    this.tags = await this.graphStore.loadTags();
  }

  private requireRepoState(): SessionRepoState {
    if (!this.repoState) {
      throw new Error("Session repo 尚未加载。");
    }
    return this.repoState;
  }

  private async ensureCheckpoint(
    snapshot: SessionSnapshot,
    force: boolean,
  ): Promise<SessionNode | undefined> {
    await this.ensureRepoLoaded();
    const currentSnapshot = cloneSnapshot(
      snapshot,
      this.requireRepoState().workingSessionId,
    );
    const currentHash = snapshotHash(currentSnapshot);
    const headNode = await this.requireNode(this.requireRepoState().headNodeId);
    if (!force && currentHash === headNode.snapshotHash) {
      return undefined;
    }

    const checkpointNode = this.buildNode({
      kind: "checkpoint",
      parentNodeIds: [headNode.id],
      snapshot: currentSnapshot,
      workingSessionId: this.requireRepoState().workingSessionId,
      abstractAssets: [],
    });
    await this.graphStore.saveNode(checkpointNode);
    this.requireRepoState().headNodeId = checkpointNode.id;

    if (this.requireRepoState().currentBranchName) {
      this.updateBranchHead(this.requireRepoState().currentBranchName, checkpointNode.id);
    } else if (this.requireRepoState().detachedTagName) {
      this.requireRepoState().detachedNodeId = checkpointNode.id;
      this.requireRepoState().detachedTagName = undefined;
    } else {
      this.requireRepoState().detachedNodeId = checkpointNode.id;
    }

    await this.saveRepoMetadata();
    return checkpointNode;
  }

  private updateBranchHead(branchName: string | undefined, headNodeId: string): void {
    if (!branchName) {
      return;
    }

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

  private async saveRepoMetadata(): Promise<void> {
    await Promise.all([
      this.graphStore.saveState(this.requireRepoState()),
      this.graphStore.saveBranches(this.branches),
      this.graphStore.saveTags(this.tags),
    ]);
  }

  private buildNode(input: {
    kind: SessionNode["kind"];
    parentNodeIds: string[];
    snapshot: SessionSnapshot;
    workingSessionId: string;
    abstractAssets: SessionAbstractAsset[];
  }): SessionNode {
    const nodeId = createId("node");
    const clonedSnapshot = cloneSnapshot(input.snapshot, input.workingSessionId);
    const baseAsset =
      input.kind === "merge"
        ? undefined
        : buildNodeSummaryAsset(
            input.kind,
            nodeId,
            clonedSnapshot,
            input.parentNodeIds.length > 0 ? input.parentNodeIds : [nodeId],
          );

    return {
      id: nodeId,
      parentNodeIds: input.parentNodeIds,
      kind: input.kind,
      workingSessionId: input.workingSessionId,
      snapshot: clonedSnapshot,
      abstractAssets: dedupeAssets(
        baseAsset ? [baseAsset, ...input.abstractAssets] : input.abstractAssets,
      ),
      snapshotHash: snapshotHash(clonedSnapshot),
      createdAt: new Date().toISOString(),
    };
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

  private async ensureUniqueBranchName(baseName: string): Promise<string> {
    let candidate = baseName;
    let counter = 1;
    while (this.branches.some((branch) => branch.name === candidate)) {
      candidate = `${baseName}-${counter}`;
      counter += 1;
    }
    return candidate;
  }

  private async resolveRef(ref: string): Promise<
    | { kind: "branch"; ref: SessionBranchRef; node: SessionNode }
    | { kind: "tag"; ref: SessionTagRef; node: SessionNode }
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

    const node = await this.graphStore.loadNode(ref);
    if (node) {
      return {
        kind: "node",
        node,
      };
    }

    throw new Error(`未找到 session ref：${ref}`);
  }

  private async requireNode(nodeId: string): Promise<SessionNode> {
    const node = await this.graphStore.loadNode(nodeId);
    if (!node) {
      throw new Error(`未找到 session node：${nodeId}`);
    }
    return node;
  }
}
