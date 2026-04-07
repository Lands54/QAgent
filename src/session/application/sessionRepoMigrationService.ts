import { copyFile, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  SessionBranchRef,
  SessionNode,
  SessionRepoState,
  SessionSnapshot,
  SessionTagRef,
  SessionWorkingHead,
} from "../../types.js";
import { ensureDir, pathExists, readJsonIfExists, writeJson } from "../../utils/index.js";
import {
  DEFAULT_BRANCH_NAME,
  type LegacySessionNode,
  type LegacySessionRecord,
  type LegacySessionRepoStateV1,
  type LegacySessionSnapshot,
  normalizeLegacyNodesForHead,
  normalizeLegacySnapshot,
} from "../domain/sessionDomain.js";
import type { SessionGraphStore } from "../sessionGraphStore.js";
import type { SessionStore } from "../sessionStore.js";

interface SessionRepoMigrationServiceInput {
  sessionRoot: string;
  graphStore: SessionGraphStore;
  sessionStore: SessionStore;
  runForkProviders: (
    head: SessionWorkingHead,
    snapshot: SessionSnapshot,
    sourceHead?: SessionWorkingHead,
  ) => Promise<Record<string, unknown>>;
  buildNode: (input: {
    kind: SessionNode["kind"];
    parentNodeIds: string[];
    snapshot: ReturnType<typeof normalizeLegacySnapshot>;
    assetState: Record<string, unknown>;
  }) => SessionNode;
}

export interface LegacyMigrationResult {
  infoMessage: string;
  repoState: SessionRepoState;
  branches: SessionBranchRef[];
  tags: SessionTagRef[];
  heads: SessionWorkingHead[];
}

export class SessionRepoMigrationService {
  public constructor(private readonly input: SessionRepoMigrationServiceInput) {}

  public async migrateLegacyRepo(
    state: LegacySessionRepoStateV1,
  ): Promise<LegacyMigrationResult> {
    const legacySessions = await this.listLegacySessions();
    const legacyNodes = await this.listLegacyNodes();
    const legacyBranches = await this.input.graphStore.loadBranches();
    const legacyTags = await this.input.graphStore.loadTags();
    const now = new Date().toISOString();

    const activeSessionId =
      state.workingSessionId
      ?? legacyNodes.find((node) => node.workingSessionId)?.workingSessionId
      ?? legacySessions.at(0)?.sessionId;
    if (!activeSessionId) {
      throw new Error("当前版本不兼容 v1 session repo，请手动清理或迁移后再启动。");
    }

    const activeHeadId = activeSessionId;
    const activeNode = legacyNodes.find(
      (node): node is LegacySessionNode & { id: string } => {
        return Boolean(node.id) && node.id === state.headNodeId;
      },
    );
    const activeLegacySession = legacySessions.find((item) => {
      return item.sessionId === activeSessionId;
    });
    const activeSnapshot = normalizeLegacySnapshot(
      activeLegacySession?.snapshot ?? activeNode?.snapshot,
      activeHeadId,
      activeSessionId,
      now,
    );

    const migratedActiveNodes = activeNode
      ? normalizeLegacyNodesForHead(legacyNodes, activeHeadId, activeSessionId)
      : [];
    const existingNodeIds = new Set(migratedActiveNodes.map((node) => node.id));

    const activeHead: SessionWorkingHead = {
      id: activeHeadId,
      name: state.currentBranchName ?? state.defaultBranchName ?? DEFAULT_BRANCH_NAME,
      currentNodeId: "",
      sessionId: activeSessionId,
      attachment: {
        mode: "detached-node",
        name: "",
        nodeId: "",
      },
      writerLease: undefined,
      runtimeState: {
        shellCwd: activeSnapshot.shellCwd,
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
      createdAt: activeSnapshot.createdAt,
      updatedAt: activeSnapshot.updatedAt,
    };
    activeHead.assetState = await this.input.runForkProviders(
      activeHead,
      activeSnapshot,
    );

    const nextNodes = [...migratedActiveNodes];
    if (!activeNode) {
      const synthesizedNode = this.input.buildNode({
        kind: "root",
        parentNodeIds: [],
        snapshot: activeSnapshot,
        assetState: activeHead.assetState,
      });
      activeHead.currentNodeId = synthesizedNode.id;
      nextNodes.push(synthesizedNode);
      existingNodeIds.add(synthesizedNode.id);
    } else {
      activeHead.currentNodeId = activeNode.id;
    }

    let nextBranches = legacyBranches.filter((branch) => {
      return existingNodeIds.has(branch.headNodeId);
    });
    const activeBranchName =
      state.currentBranchName ?? state.defaultBranchName ?? DEFAULT_BRANCH_NAME;
    const activeBranch = nextBranches.find((branch) => {
      return branch.name === activeBranchName;
    });
    if (activeBranch) {
      activeBranch.headNodeId = activeHead.currentNodeId;
      activeBranch.updatedAt = now;
    } else {
      nextBranches.push({
        name: activeBranchName,
        headNodeId: activeHead.currentNodeId,
        createdAt: activeSnapshot.createdAt,
        updatedAt: now,
      });
    }
    nextBranches = nextBranches.sort((left, right) => {
      return left.name.localeCompare(right.name);
    });

    activeHead.attachment = {
      mode: "branch",
      name: activeBranchName,
      nodeId: activeHead.currentNodeId,
    };
    activeHead.writerLease = {
      branchName: activeBranchName,
      acquiredAt: now,
    };

    const additionalHeads: SessionWorkingHead[] = [];
    const additionalSnapshots: Array<{
      headId: string;
      snapshot: ReturnType<typeof normalizeLegacySnapshot>;
    }> = [];
    for (const [index, legacySession] of legacySessions.entries()) {
      if (legacySession.sessionId === activeSessionId) {
        continue;
      }
      const headId = legacySession.sessionId;
      const snapshot = normalizeLegacySnapshot(
        legacySession.snapshot,
        headId,
        legacySession.sessionId,
        now,
      );
      const head: SessionWorkingHead = {
        id: headId,
        name: `legacy-${index}`,
        currentNodeId: "",
        sessionId: legacySession.sessionId,
        attachment: {
          mode: "detached-node",
          name: "",
          nodeId: "",
        },
        writerLease: undefined,
        runtimeState: {
          shellCwd: snapshot.shellCwd,
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
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      };
      head.assetState = await this.input.runForkProviders(head, snapshot);
      const node = this.input.buildNode({
        kind: "root",
        parentNodeIds: [],
        snapshot,
        assetState: head.assetState,
      });
      head.currentNodeId = node.id;
      head.attachment = {
        mode: "detached-node",
        name: node.id,
        nodeId: node.id,
      };
      nextNodes.push(node);
      additionalHeads.push(head);
      additionalSnapshots.push({ headId, snapshot });
    }

    const nextTags = legacyTags.filter((tag) => {
      return existingNodeIds.has(tag.targetNodeId);
    });
    const repoState: SessionRepoState = {
      version: 2,
      activeWorkingHeadId: activeHead.id,
      defaultBranchName: DEFAULT_BRANCH_NAME,
      createdAt: activeSnapshot.createdAt,
      updatedAt: now,
    };
    const nextHeads = [activeHead, ...additionalHeads];

    await this.backupLegacyRepoState(state);
    await this.input.graphStore.saveState(repoState);
    await this.input.graphStore.saveBranches(nextBranches);
    await this.input.graphStore.saveTags(nextTags);
    await Promise.all([
      ...nextNodes.map(async (node) => this.input.graphStore.saveNode(node)),
      ...nextHeads.map(async (head) => this.input.graphStore.saveHead(head)),
      this.input.sessionStore.saveSnapshot(activeSnapshot),
      ...additionalSnapshots.map(async ({ snapshot }) => {
        await this.input.sessionStore.saveSnapshot(snapshot);
      }),
    ]);
    await Promise.all([
      this.copyLegacyEvents(activeSessionId, activeHead.id),
      ...additionalHeads.map(async (head) => {
        await this.copyLegacyEvents(head.sessionId, head.id);
      }),
    ]);

    return {
      infoMessage: `已尽力将 v1 session repo 迁移为 v2；恢复 ${nextHeads.length} 个 working heads。`,
      repoState,
      branches: nextBranches,
      tags: nextTags,
      heads: nextHeads,
    };
  }

  private async listLegacyNodes(): Promise<LegacySessionNode[]> {
    const nodes = await this.input.graphStore.listNodes();
    return nodes as unknown as LegacySessionNode[];
  }

  private async listLegacySessions(): Promise<LegacySessionRecord[]> {
    try {
      const entries = await readdir(this.input.sessionRoot, { withFileTypes: true });
      const sessions = await Promise.all(
        entries
          .filter((entry) => {
            return entry.isDirectory() && entry.name.startsWith("session_");
          })
          .map(async (entry) => {
            const sessionId = entry.name;
            const dirPath = path.join(this.input.sessionRoot, entry.name);
            const snapshotPath = path.join(dirPath, "snapshot.json");
            const snapshot = await readJsonIfExists<LegacySessionSnapshot>(snapshotPath);
            if (!snapshot) {
              return undefined;
            }
            return {
              sessionId,
              snapshot,
              snapshotPath,
              eventsPath: path.join(dirPath, "events.ndjson"),
            } satisfies LegacySessionRecord;
          }),
      );
      return sessions
        .filter((session): session is LegacySessionRecord => Boolean(session))
        .sort((left, right) => {
          return (
            right.snapshot.updatedAt?.localeCompare(left.snapshot.updatedAt ?? "") ?? 0
          );
        });
    } catch {
      return [];
    }
  }

  private async backupLegacyRepoState(
    state: LegacySessionRepoStateV1,
  ): Promise<void> {
    const backupPath = path.join(
      this.input.sessionRoot,
      "__repo",
      "legacy-v1-state.json",
    );
    if (await pathExists(backupPath)) {
      return;
    }
    await writeJson(backupPath, state);
  }

  private async copyLegacyEvents(
    sessionId: string,
    headId: string,
  ): Promise<void> {
    const sourcePath = path.join(this.input.sessionRoot, sessionId, "events.ndjson");
    if (!(await pathExists(sourcePath))) {
      return;
    }
    const targetPath = path.join(
      this.input.sessionRoot,
      "__heads",
      headId,
      "events.ndjson",
    );
    await ensureDir(path.dirname(targetPath));
    await copyFile(sourcePath, targetPath);
  }
}
