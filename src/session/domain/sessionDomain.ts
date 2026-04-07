import { createHash } from "node:crypto";

import type {
  ApprovalMode,
  SessionAbstractAsset,
  SessionNode,
  SessionRefInfo,
  SessionRepoState,
  SessionSnapshot,
  SessionWorkingHead,
} from "../../types.js";

export const DEFAULT_BRANCH_NAME = "main" as const;
export const SESSION_REF_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const V1_INCOMPATIBLE_MESSAGE =
  "当前版本不兼容 v1 session repo，请手动清理或迁移后再启动。";

export interface LegacySessionRepoStateV1 {
  version?: 1;
  currentBranchName?: string;
  headNodeId?: string;
  workingSessionId?: string;
  defaultBranchName?: string;
}

export interface LegacySessionSnapshot {
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
  cwd?: string;
  shellCwd?: string;
  approvalMode?: ApprovalMode;
  uiMessages?: SessionSnapshot["uiMessages"];
  modelMessages?: SessionSnapshot["modelMessages"];
  lastUserPrompt?: string;
  lastRunSummary?: string;
}

export interface LegacySessionNode {
  id?: string;
  parentNodeIds?: string[];
  kind?: SessionNode["kind"];
  workingSessionId?: string;
  snapshot?: LegacySessionSnapshot;
  abstractAssets?: SessionAbstractAsset[];
  snapshotHash?: string;
  createdAt?: string;
}

export interface LegacySessionRecord {
  sessionId: string;
  snapshot: LegacySessionSnapshot;
  snapshotPath: string;
  eventsPath: string;
}

export function isLegacyRepoState(
  value: unknown,
): value is LegacySessionRepoStateV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as LegacySessionRepoStateV1;
  return state.version === 1 || Boolean(state.currentBranchName || state.workingSessionId);
}

export function cloneSnapshotForHead(
  snapshot: SessionSnapshot,
  head: SessionWorkingHead,
): SessionSnapshot {
  return {
    ...snapshot,
    workingHeadId: head.id,
    sessionId: head.sessionId,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeSnapshotForHash(
  snapshot: SessionSnapshot,
): Record<string, unknown> {
  return {
    workingHeadId: snapshot.workingHeadId,
    cwd: snapshot.cwd,
    shellCwd: snapshot.shellCwd,
    approvalMode: snapshot.approvalMode,
    modelMessages: snapshot.modelMessages,
    lastUserPrompt: snapshot.lastUserPrompt ?? "",
    lastRunSummary: snapshot.lastRunSummary ?? "",
  };
}

export function snapshotHash(snapshot: SessionSnapshot): string {
  return createHash("sha1")
    .update(JSON.stringify(normalizeSnapshotForHash(snapshot)))
    .digest("hex");
}

export function dedupeAssets(
  assets: SessionAbstractAsset[],
): SessionAbstractAsset[] {
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

export function attachmentLabel(
  attachment: SessionWorkingHead["attachment"],
): string {
  if (attachment.mode === "branch") {
    return `branch=${attachment.name}`;
  }
  if (attachment.mode === "tag") {
    return `detached=tag:${attachment.name}`;
  }
  return `detached=node:${attachment.nodeId}`;
}

export function attachmentModeToRefMode(
  mode: SessionWorkingHead["attachment"]["mode"],
): SessionRefInfo["mode"] {
  if (mode === "branch") {
    return "branch";
  }
  if (mode === "tag") {
    return "detached-tag";
  }
  return "detached-node";
}

export function formatUtcTimestamp(value = new Date()): string {
  return value
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "")
    .toLowerCase();
}

export function normalizeLegacySnapshot(
  snapshot: LegacySessionSnapshot | undefined,
  headId: string,
  sessionId: string,
  fallbackTime: string,
): SessionSnapshot {
  return {
    workingHeadId: headId,
    sessionId,
    createdAt: snapshot?.createdAt ?? fallbackTime,
    updatedAt: snapshot?.updatedAt ?? snapshot?.createdAt ?? fallbackTime,
    cwd: snapshot?.cwd ?? process.cwd(),
    shellCwd: snapshot?.shellCwd ?? snapshot?.cwd ?? process.cwd(),
    approvalMode: snapshot?.approvalMode ?? "always",
    uiMessages: snapshot?.uiMessages ?? [],
    modelMessages: snapshot?.modelMessages ?? [],
    lastUserPrompt: snapshot?.lastUserPrompt,
    lastRunSummary: snapshot?.lastRunSummary,
  };
}

export function normalizeLegacyNodesForHead(
  nodes: LegacySessionNode[],
  headId: string,
  sessionId: string,
): SessionNode[] {
  return nodes
    .filter((node): node is Required<Pick<LegacySessionNode, "id">> & LegacySessionNode => {
      return Boolean(node.id);
    })
    .map((node) => {
      const normalizedSnapshot = normalizeLegacySnapshot(
        node.snapshot,
        headId,
        sessionId,
        node.createdAt ?? new Date().toISOString(),
      );
      return {
        id: node.id,
        parentNodeIds: node.parentNodeIds ?? [],
        kind: node.kind ?? "checkpoint",
        snapshot: normalizedSnapshot,
        abstractAssets: node.abstractAssets ?? [],
        snapshotHash: snapshotHash(normalizedSnapshot),
        createdAt: node.createdAt ?? normalizedSnapshot.createdAt,
      } satisfies SessionNode;
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function createRepoState(
  activeWorkingHeadId: string,
  createdAt = new Date().toISOString(),
): SessionRepoState {
  return {
    version: 2,
    activeWorkingHeadId,
    defaultBranchName: DEFAULT_BRANCH_NAME,
    createdAt,
    updatedAt: createdAt,
  };
}
