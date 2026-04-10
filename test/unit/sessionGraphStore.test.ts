import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SessionGraphStore } from "../../src/session/index.js";
import type {
  SessionBranchRef,
  SessionCommitRecord,
  SessionNode,
  SessionRepoState,
  SessionSnapshot,
  SessionTagRef,
  SessionWorkingHead,
} from "../../src/types.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function buildSnapshot(sessionId: string, workingHeadId: string): SessionSnapshot {
  return {
    workingHeadId,
    sessionId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    shellCwd: "/tmp/project",
    approvalMode: "always",
    uiMessages: [],
    modelMessages: [],
    lastUserPrompt: "hello",
  };
}

describe("SessionGraphStore", () => {
  it("能保存并恢复 repo state / refs / nodes", async () => {
    const root = await makeTempDir("qagent-session-graph-");
    const store = new SessionGraphStore(root);
    const state: SessionRepoState = {
      version: 2,
      activeWorkingHeadId: "head_main",
      defaultBranchName: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const branches: SessionBranchRef[] = [
      {
        name: "main",
        headNodeId: "node_main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const tags: SessionTagRef[] = [
      {
        name: "baseline",
        targetNodeId: "node_main",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const node: SessionNode = {
      id: "node_main",
      parentNodeIds: [],
      kind: "root",
      snapshot: buildSnapshot("session_demo", "head_main"),
      abstractAssets: [],
      snapshotHash: "hash_main",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const commits: SessionCommitRecord[] = [
      {
        id: "commit_main",
        message: "初始化",
        nodeId: "node_main",
        headId: "head_main",
        sessionId: "session_demo",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const heads: SessionWorkingHead[] = [
      {
        id: "head_main",
        name: "main",
        currentNodeId: "node_main",
        sessionId: "session_demo",
        attachment: {
          mode: "branch",
          name: "main",
          nodeId: "node_main",
        },
        writerLease: {
          branchName: "main",
          acquiredAt: "2026-01-01T00:00:00.000Z",
        },
        runtimeState: {
          shellCwd: "/tmp/project",
          status: "idle",
        },
        assetState: {},
        status: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    await store.initializeRepo({
      state,
      branches,
      tags,
      commits,
      nodes: [node],
      heads,
    });

    expect(await store.repoExists()).toBe(true);
    expect(await store.loadState()).toEqual(state);
    expect(await store.loadBranches()).toEqual(branches);
    expect(await store.loadTags()).toEqual(tags);
    expect(await store.loadCommits()).toEqual(commits);
    expect(await store.loadNode("node_main")).toEqual(node);
    expect(await store.listNodes()).toEqual([node]);
    expect(await store.loadHead("head_main")).toEqual(heads[0]);
    expect(await store.listHeads()).toEqual(heads);
  });

  it("会跳过损坏的 node/head JSON，而不是打断列表读取", async () => {
    const root = await makeTempDir("qagent-session-graph-corrupt-");
    const store = new SessionGraphStore(root);
    const state: SessionRepoState = {
      version: 2,
      activeWorkingHeadId: "head_main",
      defaultBranchName: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const node: SessionNode = {
      id: "node_main",
      parentNodeIds: [],
      kind: "root",
      snapshot: buildSnapshot("session_demo", "head_main"),
      abstractAssets: [],
      snapshotHash: "hash_main",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const head: SessionWorkingHead = {
      id: "head_main",
      name: "main",
      currentNodeId: "node_main",
      sessionId: "session_demo",
      attachment: {
        mode: "branch",
        name: "main",
        nodeId: "node_main",
      },
      runtimeState: {
        shellCwd: "/tmp/project",
        status: "idle",
      },
      assetState: {},
      status: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await store.initializeRepo({
      state,
      branches: [],
      tags: [],
      commits: [],
      nodes: [node],
      heads: [head],
    });
    await writeFile(
      path.join(root, "__repo", "nodes", "node_bad.json"),
      "{",
      "utf8",
    );
    await writeFile(
      path.join(root, "__repo", "heads", "head_bad.json"),
      "{",
      "utf8",
    );

    expect(await store.loadNode("node_bad")).toBeUndefined();
    expect(await store.loadHead("head_bad")).toBeUndefined();
    expect(await store.listNodes()).toEqual([node]);
    expect(await store.listHeads()).toEqual([head]);
  });
});
