import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SessionGraphStore, SessionService } from "../../src/session/index.js";
import type { LlmMessage, SessionAssetProvider, SessionSnapshot } from "../../src/types.js";
import { createId, pathExists, writeJson } from "../../src/utils/index.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function withAssistantMessage(
  snapshot: SessionSnapshot,
  content: string,
): SessionSnapshot {
  const message: LlmMessage = {
    id: createId("llm"),
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  };

  return {
    ...snapshot,
    modelMessages: [...snapshot.modelMessages, message],
    lastUserPrompt: content,
  };
}

describe("SessionService", () => {
  it("能初始化 session repo，并默认附着在 main 分支", async () => {
    const root = await makeTempDir("qagent-session-service-");
    const service = new SessionService(root);
    const graphStore = new SessionGraphStore(root);

    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    expect(initialized.snapshot.sessionId).toBeTruthy();
    expect(initialized.ref.label).toBe("branch=main");
    expect(initialized.ref.mode).toBe("branch");

    const refs = await service.listRefs(initialized.snapshot);
    expect(refs.branches).toHaveLength(1);
    expect(refs.branches[0]?.name).toBe("main");

    const nodes = await graphStore.listNodes();
    expect(nodes[0]?.abstractAssets[0]?.tags).toContain("digest");
  });

  it("初始化失败时会回滚半成品 session repo", async () => {
    const root = await makeTempDir("qagent-session-init-rollback-");
    const failingProvider: SessionAssetProvider = {
      kind: "failing-provider",
      async fork() {
        throw new Error("fork boom");
      },
      async checkpoint(input) {
        return input.state;
      },
      async merge(input) {
        return {
          targetState: input.targetState,
        };
      },
    };
    const service = new SessionService(root, [failingProvider]);
    const graphStore = new SessionGraphStore(root);

    await expect(service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    })).rejects.toThrow("fork boom");

    expect(await graphStore.repoExists()).toBe(false);
    expect(await pathExists(path.join(root, "__repo"))).toBe(false);

    const headEntries = await readdir(path.join(root, "__heads"), {
      withFileTypes: true,
    }).catch(() => []);
    expect(headEntries.filter((entry) => entry.isDirectory())).toHaveLength(0);
  });

  it("forkHead 失败时会回滚 helper head 的 snapshot 与 metadata", async () => {
    const root = await makeTempDir("qagent-session-fork-rollback-");
    let shouldFailFork = false;
    const provider: SessionAssetProvider = {
      kind: "fork-rollback-provider",
      async fork() {
        if (shouldFailFork) {
          throw new Error("fork helper boom");
        }
        return {};
      },
      async checkpoint(input) {
        return input.state;
      },
      async merge(input) {
        return {
          targetState: input.targetState,
        };
      },
    };
    const service = new SessionService(root, [provider]);
    const graphStore = new SessionGraphStore(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    shouldFailFork = true;

    await expect(service.forkHead("helper-worker", {
      sourceHeadId: initialized.head.id,
      activate: false,
    })).rejects.toThrow("fork helper boom");

    const headEntries = await readdir(path.join(root, "__heads"), {
      withFileTypes: true,
    });
    expect(headEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toEqual([
      initialized.head.id,
    ]);
    const repoHeadEntries = await readdir(path.join(root, "__repo", "heads"), {
      withFileTypes: true,
    });
    expect(repoHeadEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([
      `${initialized.head.id}.json`,
    ]);
    expect((await service.listHeads(initialized.snapshot)).heads).toHaveLength(1);
    expect((await service.getActiveHead()).id).toBe(initialized.head.id);
    expect(await graphStore.repoExists()).toBe(true);
  });

  it("checkout tag 后首次继续对话会自动创建新分支", async () => {
    const root = await makeTempDir("qagent-session-tag-");
    const service = new SessionService(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    await service.createTag("baseline", initialized.snapshot);
    const checkout = await service.checkout("baseline", initialized.snapshot);
    const autoBranch = await service.prepareForUserInput(checkout.snapshot);
    const refs = await service.listRefs(checkout.snapshot);

    expect(checkout.ref.label).toBe("detached=tag:baseline");
    expect(autoBranch?.ref.mode).toBe("branch");
    expect(autoBranch?.ref.name.startsWith("from-tag-baseline-")).toBe(true);
    expect(refs.branches.some((branch) => branch.name.startsWith("from-tag-baseline-"))).toBe(
      true,
    );
  });

  it("merge 只合并抽象资产，不覆盖当前分支的 runtime snapshot", async () => {
    const root = await makeTempDir("qagent-session-merge-");
    const service = new SessionService(root);
    const graphStore = new SessionGraphStore(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    const mainSnapshot = withAssistantMessage(
      initialized.snapshot,
      "main branch summary",
    );
    await service.persistWorkingSnapshot(mainSnapshot);
    await service.createBranch("alt", mainSnapshot);
    const altCheckout = await service.checkout("alt", mainSnapshot);
    const altSnapshot = withAssistantMessage(altCheckout.snapshot, "alt branch summary");
    await service.persistWorkingSnapshot(altSnapshot);
    const backToMain = await service.checkout("main", altSnapshot);
    await service.merge("alt", backToMain.snapshot);

    const nodes = await graphStore.listNodes();
    const mergeNode = nodes.at(-1);

    expect(mergeNode?.kind).toBe("merge");
    expect(mergeNode?.parentNodeIds).toHaveLength(2);
    expect(
      mergeNode?.abstractAssets.some((asset) => asset.title === "merge:alt"),
    ).toBe(true);
    expect(
      mergeNode?.abstractAssets.some((asset) => asset.tags.includes("digest")),
    ).toBe(true);
    expect(mergeNode?.snapshot.modelMessages.at(-1)).toEqual(
      backToMain.snapshot.modelMessages.at(-1),
    );
    expect(mergeNode?.snapshot.modelMessages.at(-1)).not.toEqual(
      altSnapshot.modelMessages.at(-1),
    );
  });

  it("同一 branch 同时只允许一个 writer head", async () => {
    const root = await makeTempDir("qagent-session-writer-");
    const service = new SessionService(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    const detached = await service.forkHead("worker-a", {
      sourceHeadId: initialized.head.id,
      activate: false,
    });

    await expect(
      service.attachHead(detached.head.id, "main"),
    ).rejects.toThrow(/writer lease/);
  });

  it("detached working heads 的 snapshot 彼此隔离", async () => {
    const root = await makeTempDir("qagent-session-isolation-");
    const service = new SessionService(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    const detached = await service.forkHead("worker-a", {
      sourceHeadId: initialized.head.id,
      activate: false,
    });

    const workerSnapshot = withAssistantMessage(
      detached.snapshot,
      "worker branch summary",
    );
    await service.persistWorkingSnapshot(workerSnapshot);
    await service.flushCheckpointIfDirty(workerSnapshot);

    const mainSnapshot = await service.getHeadSnapshot(initialized.head.id);
    const detachedSnapshot = await service.getHeadSnapshot(detached.head.id);

    expect(mainSnapshot.modelMessages).toHaveLength(0);
    expect(detachedSnapshot.modelMessages.at(-1)?.role).toBe("assistant");
    expect(detachedSnapshot.modelMessages.at(-1)?.content).toContain("worker branch summary");
  });

  it("dirty snapshot 上 createCommit 会先 materialize checkpoint node", async () => {
    const root = await makeTempDir("qagent-session-commit-dirty-");
    const service = new SessionService(root);
    const graphStore = new SessionGraphStore(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    const dirtySnapshot = withAssistantMessage(
      initialized.snapshot,
      "dirty commit summary",
    );

    await service.persistWorkingSnapshot(dirtySnapshot);
    const beforeNodes = await graphStore.listNodes();
    const result = await service.createCommit("保存 dirty 状态", dirtySnapshot);
    const afterNodes = await graphStore.listNodes();
    const commits = await graphStore.loadCommits();

    expect(afterNodes).toHaveLength(beforeNodes.length + 1);
    expect(afterNodes.at(-1)?.kind).toBe("checkpoint");
    expect(result.commit.nodeId).toBe(afterNodes.at(-1)?.id);
    expect(commits.at(-1)?.message).toBe("保存 dirty 状态");
  });

  it("clean snapshot 上 createCommit 只创建 commit record，不新增 node", async () => {
    const root = await makeTempDir("qagent-session-commit-clean-");
    const service = new SessionService(root);
    const graphStore = new SessionGraphStore(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    const beforeNodes = await graphStore.listNodes();
    const result = await service.createCommit("标记初始状态", initialized.snapshot);
    const afterNodes = await graphStore.listNodes();
    const commits = await graphStore.loadCommits();

    expect(afterNodes).toHaveLength(beforeNodes.length);
    expect(result.commit.nodeId).toBe(initialized.head.currentNodeId);
    expect(commits.at(-1)?.id).toBe(result.commit.id);
    expect(commits.at(-1)?.message).toBe("标记初始状态");
  });

  it("checkout 支持 commit id，并优先按 branch > tag > commit > node 解析", async () => {
    const root = await makeTempDir("qagent-session-commit-ref-");
    const service = new SessionService(root);
    const graphStore = new SessionGraphStore(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    const rootNodeId = initialized.head.currentNodeId;

    const firstSnapshot = withAssistantMessage(
      initialized.snapshot,
      "first commit summary",
    );
    await service.persistWorkingSnapshot(firstSnapshot);
    const firstCommit = await service.createCommit("first", firstSnapshot);

    const secondSnapshot = withAssistantMessage(
      await service.getHeadSnapshot(initialized.head.id),
      "second checkpoint summary",
    );
    await service.persistWorkingSnapshot(secondSnapshot);
    await service.flushCheckpointIfDirty(secondSnapshot);

    const existingCommits = await graphStore.loadCommits();
    await graphStore.saveCommits([
      ...existingCommits,
      {
        id: rootNodeId,
        message: "prefer commit over raw node id",
        nodeId: firstCommit.commit.nodeId,
        headId: initialized.head.id,
        sessionId: initialized.head.sessionId,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ]);

    await service.dispose();
    const resumedService = new SessionService(root);
    const resumed = await resumedService.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    const checkout = await resumedService.checkout(rootNodeId, resumed.snapshot);

    expect(checkout.head.currentNodeId).toBe(firstCommit.commit.nodeId);
    expect(checkout.snapshot.modelMessages.at(-1)?.content).toBe("first commit summary");
    await resumedService.dispose();
  });

  it("已有 repo 时，显式 resume 指定 sessionId 会切换到对应 working head", async () => {
    const root = await makeTempDir("qagent-session-resume-");
    const service = new SessionService(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    const forked = await service.forkHead("worker-a", {
      sourceHeadId: initialized.head.id,
      activate: false,
    });
    const forkSnapshot = {
      ...forked.snapshot,
      shellCwd: "/tmp/project/worker-a",
    };
    await service.persistWorkingSnapshot(forkSnapshot);

    await service.dispose();
    const resumedService = new SessionService(root);
    const resumed = await resumedService.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
      resumeSessionId: forked.head.sessionId,
    });

    expect(resumed.snapshot.sessionId).toBe(forked.head.sessionId);
    expect(resumed.snapshot.shellCwd).toBe("/tmp/project/worker-a");
    expect(resumed.ref.workingHeadId).toBe(forked.head.id);
    expect(resumed.head.name).toBe("worker-a");
    await resumedService.dispose();
  });

  it("同一 sessionRoot 下第二个 SessionService 不能同时 initialize", async () => {
    const root = await makeTempDir("qagent-session-single-owner-");
    const first = new SessionService(root, [], {
      ownerKind: "test-first",
      processLeaseHeartbeatMs: 5,
      processLeaseTtlMs: 20,
      mutationHeartbeatMs: 5,
      mutationTtlMs: 20,
      mutationPollMs: 5,
    });
    const second = new SessionService(root, [], {
      ownerKind: "test-second",
      processLeaseHeartbeatMs: 5,
      processLeaseTtlMs: 20,
      mutationHeartbeatMs: 5,
      mutationTtlMs: 20,
      mutationPollMs: 5,
    });

    await first.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    await expect(
      second.initialize({
        cwd: "/tmp/project",
        shellCwd: "/tmp/project",
        approvalMode: "always",
      }),
    ).rejects.toThrow(/session lock process 当前已被占用/);

    await first.dispose();
    await expect(
      second.initialize({
        cwd: "/tmp/project",
        shellCwd: "/tmp/project",
        approvalMode: "always",
      }),
    ).resolves.toMatchObject({
      ref: {
        label: "branch=main",
      },
    });
    await second.dispose();
  });

  it("能尽力迁移 v1 session repo，并导入旧 session 为 working heads", async () => {
    const root = await makeTempDir("qagent-session-v1-");
    const activeSessionId = "session_active";
    const extraSessionId = "session_extra";
    const activeNodeId = "node_active";
    const activeSnapshot = {
      sessionId: activeSessionId,
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:10:00.000Z",
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
      uiMessages: [],
      modelMessages: [],
      lastUserPrompt: "hello legacy",
    };
    const extraSnapshot = {
      sessionId: extraSessionId,
      createdAt: "2026-04-05T11:00:00.000Z",
      updatedAt: "2026-04-05T11:05:00.000Z",
      cwd: "/tmp/project",
      shellCwd: "/tmp/project/extra",
      approvalMode: "always",
      uiMessages: [],
      modelMessages: [],
      lastUserPrompt: "extra legacy",
    };

    await writeJson(path.join(root, "__repo", "state.json"), {
      version: 1,
      currentBranchName: "main",
      headNodeId: activeNodeId,
      workingSessionId: activeSessionId,
      defaultBranchName: "main",
    });
    await writeJson(path.join(root, "__repo", "branches.json"), [
      {
        name: "main",
        headNodeId: activeNodeId,
        createdAt: activeSnapshot.createdAt,
        updatedAt: activeSnapshot.updatedAt,
      },
    ]);
    await writeJson(path.join(root, "__repo", "tags.json"), []);
    await writeJson(path.join(root, "__repo", "nodes", `${activeNodeId}.json`), {
      id: activeNodeId,
      parentNodeIds: [],
      kind: "root",
      workingSessionId: activeSessionId,
      snapshot: activeSnapshot,
      abstractAssets: [],
      snapshotHash: "legacy-hash",
      createdAt: activeSnapshot.createdAt,
    });
    await writeJson(path.join(root, activeSessionId, "snapshot.json"), activeSnapshot);
    await writeJson(path.join(root, extraSessionId, "snapshot.json"), extraSnapshot);

    const service = new SessionService(root);
    const initialized = await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    expect(initialized.infoMessage).toContain("迁移为 v2");
    expect(initialized.ref.label).toBe("branch=main");
    expect(initialized.snapshot.workingHeadId).toBe(activeSessionId);
    expect((await service.getStatus(initialized.snapshot)).dirty).toBe(false);

    const heads = await service.listHeads(initialized.snapshot);
    expect(heads.heads).toHaveLength(2);
    expect(heads.heads.some((head) => head.sessionId === extraSessionId)).toBe(true);

    const graphStore = new SessionGraphStore(root);
    const migratedState = await graphStore.loadState();
    const migratedNode = await graphStore.loadNode(activeNodeId);

    expect(migratedState?.version).toBe(2);
    expect(migratedState?.activeWorkingHeadId).toBe(activeSessionId);
    expect(migratedNode?.snapshot.workingHeadId).toBe(activeSessionId);
  });
});
