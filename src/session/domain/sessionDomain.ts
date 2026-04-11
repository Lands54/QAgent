import { createHash } from "node:crypto";

import type {
  ApprovalMode,
  ConversationEntry,
  ConversationEntryKind,
  LlmMessage,
  SessionAbstractAsset,
  SessionNode,
  SessionRefInfo,
  SessionRepoState,
  SessionSnapshot,
  SessionWorkingHead,
  UIMessage,
} from "../../types.js";
import { createId } from "../../utils/index.js";

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
  conversationEntries?: SessionSnapshot["conversationEntries"];
  uiMessages?: SessionSnapshot["uiMessages"];
  modelMessages?: SessionSnapshot["modelMessages"];
  lastUserPrompt?: string;
  lastRunSummary?: string;
  uiClearedAt?: string;
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
  return projectSnapshotConversationEntries(
    {
      ...snapshot,
      workingHeadId: head.id,
      sessionId: head.sessionId,
      updatedAt: new Date().toISOString(),
    },
    head.runtimeState.uiContextEnabled ?? false,
  );
}

function matchesLegacyUiToModel(uiMessage: UIMessage, modelMessage: LlmMessage): boolean {
  if (modelMessage.role === "user") {
    return uiMessage.role === "user";
  }
  if (modelMessage.role === "assistant") {
    return uiMessage.role === "assistant";
  }
  if (modelMessage.role === "tool") {
    return uiMessage.role === "tool" || uiMessage.role === "error";
  }
  return false;
}

function buildDefaultModelMirrorFromUiMessage(
  message: UIMessage,
): LlmMessage | undefined {
  if (message.role === "info") {
    return {
      id: createId("llm"),
      role: "assistant",
      content: `[UI结果][INFO] ${message.content}`,
      createdAt: message.createdAt,
    };
  }
  if (message.role === "error") {
    return {
      id: createId("llm"),
      role: "assistant",
      content: `[UI结果][ERROR] ${message.content}`,
      createdAt: message.createdAt,
    };
  }
  if (message.role === "tool") {
    return {
      id: createId("llm"),
      role: "assistant",
      content: `[UI消息][TOOL] ${message.content}`,
      createdAt: message.createdAt,
    };
  }
  if (message.role === "assistant") {
    return {
      id: createId("llm"),
      role: "assistant",
      content: `[UI消息][ASSISTANT] ${message.content}`,
      createdAt: message.createdAt,
    };
  }
  if (message.role === "user") {
    return {
      id: createId("llm"),
      role: "user",
      content: `[UI消息][USER] ${message.content}`,
      createdAt: message.createdAt,
    };
  }
  return undefined;
}

function buildLegacyConversationEntries(
  uiMessages: ReadonlyArray<UIMessage>,
  modelMessages: ReadonlyArray<LlmMessage>,
): ConversationEntry[] {
  const pairedEntries: ConversationEntry[] = [];
  const matchedUiIndexes = new Set<number>();
  let uiCursor = 0;

  for (const modelMessage of modelMessages) {
    let matchedIndex: number | undefined;
    for (let index = uiCursor; index < uiMessages.length; index += 1) {
      const uiMessage = uiMessages[index];
      if (!uiMessage || matchedUiIndexes.has(index)) {
        continue;
      }
      if (!matchesLegacyUiToModel(uiMessage, modelMessage)) {
        continue;
      }
      matchedIndex = index;
      matchedUiIndexes.add(index);
      uiCursor = index + 1;
      break;
    }

    pairedEntries.push({
      id: createId("entry"),
      kind:
        modelMessage.role === "user"
          ? "user-input"
          : modelMessage.role === "assistant"
            ? "assistant-turn"
            : "tool-result",
      createdAt: modelMessage.createdAt,
      ui: matchedIndex !== undefined ? uiMessages[matchedIndex] : undefined,
      model: modelMessage,
    });
  }

  const uiOnlyEntries = uiMessages.reduce<ConversationEntry[]>(
    (entries, uiMessage, index) => {
      if (matchedUiIndexes.has(index)) {
        return entries;
      }
      const modelMirror = buildDefaultModelMirrorFromUiMessage(uiMessage);
      entries.push({
        id: createId("entry"),
        kind:
          uiMessage.role === "user"
            ? "ui-command"
            : uiMessage.role === "error"
              ? "system-error"
              : "ui-result",
        createdAt: uiMessage.createdAt,
        ui: uiMessage,
        modelMirror,
      });
      return entries;
    },
    [],
  ).sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const mergedEntries = [...pairedEntries];
  for (const entry of uiOnlyEntries) {
    let insertIndex = mergedEntries.length;
    for (let index = 0; index < mergedEntries.length; index += 1) {
      const candidate = mergedEntries[index];
      if (!candidate) {
        continue;
      }
      if (candidate.createdAt > entry.createdAt) {
        insertIndex = index;
        break;
      }
    }
    mergedEntries.splice(insertIndex, 0, entry);
  }

  return mergedEntries;
}

export function projectUiMessagesFromConversationEntries(
  entries: ReadonlyArray<ConversationEntry>,
  clearedAt?: string,
): UIMessage[] {
  return entries.flatMap((entry) => {
    if (!entry.ui) {
      return [];
    }
    if (clearedAt && entry.ui.createdAt <= clearedAt) {
      return [];
    }
    return [entry.ui];
  });
}

export function projectModelMessagesFromConversationEntries(
  entries: ReadonlyArray<ConversationEntry>,
  uiContextEnabled: boolean,
): LlmMessage[] {
  return entries.flatMap((entry) => {
    if (entry.model) {
      return [entry.model];
    }
    if (uiContextEnabled && entry.modelMirror) {
      return [entry.modelMirror];
    }
    return [];
  });
}

export function projectSnapshotConversationEntries(
  snapshot: SessionSnapshot,
  uiContextEnabled: boolean,
): SessionSnapshot {
  const conversationEntries =
    snapshot.conversationEntries.length > 0
      ? [...snapshot.conversationEntries]
      : buildLegacyConversationEntries(snapshot.uiMessages, snapshot.modelMessages);

  return {
    ...snapshot,
    conversationEntries,
    uiMessages: projectUiMessagesFromConversationEntries(
      conversationEntries,
      snapshot.uiClearedAt,
    ),
    modelMessages: projectModelMessagesFromConversationEntries(
      conversationEntries,
      uiContextEnabled,
    ),
  };
}

export function normalizeSessionSnapshot(
  snapshot: LegacySessionSnapshot | SessionSnapshot | undefined,
  input: {
    headId: string;
    sessionId: string;
    fallbackTime: string;
    uiContextEnabled: boolean;
  },
): SessionSnapshot {
  return projectSnapshotConversationEntries(
    {
      workingHeadId: input.headId,
      sessionId: input.sessionId,
      createdAt: snapshot?.createdAt ?? input.fallbackTime,
      updatedAt: snapshot?.updatedAt ?? snapshot?.createdAt ?? input.fallbackTime,
      cwd: snapshot?.cwd ?? process.cwd(),
      shellCwd: snapshot?.shellCwd ?? snapshot?.cwd ?? process.cwd(),
      approvalMode: snapshot?.approvalMode ?? "always",
      conversationEntries: snapshot?.conversationEntries ?? [],
      uiMessages: snapshot?.uiMessages ?? [],
      modelMessages: snapshot?.modelMessages ?? [],
      lastUserPrompt: snapshot?.lastUserPrompt,
      lastRunSummary: snapshot?.lastRunSummary,
      uiClearedAt: snapshot?.uiClearedAt,
    },
    input.uiContextEnabled,
  );
}

export function appendConversationEntry(
  snapshot: SessionSnapshot,
  entry: ConversationEntry,
  uiContextEnabled: boolean,
): SessionSnapshot {
  return projectSnapshotConversationEntries(
    {
      ...snapshot,
      conversationEntries: [...snapshot.conversationEntries, entry],
      updatedAt: new Date().toISOString(),
    },
    uiContextEnabled,
  );
}

export function replaceConversationEntries(
  snapshot: SessionSnapshot,
  conversationEntries: ReadonlyArray<ConversationEntry>,
  uiContextEnabled: boolean,
): SessionSnapshot {
  return projectSnapshotConversationEntries(
    {
      ...snapshot,
      conversationEntries: [...conversationEntries],
      updatedAt: new Date().toISOString(),
    },
    uiContextEnabled,
  );
}

export function resetConversationModelContext(
  snapshot: SessionSnapshot,
  uiContextEnabled: boolean,
): {
  snapshot: SessionSnapshot;
  resetEntryIds: string[];
} {
  const resetEntryIds: string[] = [];
  const conversationEntries = snapshot.conversationEntries.map((entry) => {
    if (!entry.model && !entry.modelMirror) {
      return entry;
    }
    resetEntryIds.push(entry.id);
    return {
      ...entry,
      model: undefined,
      modelMirror: undefined,
    };
  });

  return {
    snapshot: projectSnapshotConversationEntries(
      {
        ...snapshot,
        conversationEntries,
        lastUserPrompt: undefined,
        lastRunSummary: undefined,
        updatedAt: new Date().toISOString(),
      },
      uiContextEnabled,
    ),
    resetEntryIds,
  };
}

export function createConversationEntry(input: {
  kind: ConversationEntryKind;
  createdAt?: string;
  ui?: UIMessage;
  model?: LlmMessage;
  modelMirror?: LlmMessage;
}): ConversationEntry {
  const createdAt =
    input.createdAt
    ?? input.ui?.createdAt
    ?? input.model?.createdAt
    ?? input.modelMirror?.createdAt
    ?? new Date().toISOString();

  return {
    id: createId("entry"),
    kind: input.kind,
    createdAt,
    ui: input.ui,
    model: input.model,
    modelMirror: input.modelMirror,
  };
}

export function buildProjectedModelMessageEntries(
  snapshot: SessionSnapshot,
  uiContextEnabled: boolean,
): Array<{
  entryIndex: number;
  message: LlmMessage;
}> {
  return snapshot.conversationEntries.flatMap((entry, entryIndex) => {
    if (entry.model) {
      return [{ entryIndex, message: entry.model }];
    }
    if (uiContextEnabled && entry.modelMirror) {
      return [{ entryIndex, message: entry.modelMirror }];
    }
    return [];
  });
}

function normalizeEntryForHash(entry: ConversationEntry): Record<string, unknown> {
  return {
    kind: entry.kind,
    createdAt: entry.createdAt,
    ui: entry.ui,
    model: entry.model,
    modelMirror: entry.modelMirror,
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
    conversationEntries: snapshot.conversationEntries.map((entry) => {
      return normalizeEntryForHash(entry);
    }),
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
  return normalizeSessionSnapshot(snapshot, {
    headId,
    sessionId,
    fallbackTime,
    uiContextEnabled: false,
  });
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
