import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SessionGraphStore, SessionService } from "../../src/session/index.js";
import type { LlmMessage, SessionSnapshot } from "../../src/types.js";
import { createId, writeJson } from "../../src/utils/index.js";

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
      "main 分支总结",
    );
    await service.persistWorkingSnapshot(mainSnapshot);
    await service.createBranch("alt", mainSnapshot);
    const altCheckout = await service.checkout("alt", mainSnapshot);
    const altSnapshot = withAssistantMessage(altCheckout.snapshot, "alt 分支总结");
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

  it("同一分支同时只允许一个 writer head", async () => {
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
      "worker 分支总结",
    );
    await service.persistWorkingSnapshot(workerSnapshot);
    await service.flushCheckpointIfDirty(workerSnapshot);

    const mainSnapshot = await service.getHeadSnapshot(initialized.head.id);
    const detachedSnapshot = await service.getHeadSnapshot(detached.head.id);

    expect(mainSnapshot.modelMessages).toHaveLength(0);
    expect(detachedSnapshot.modelMessages.at(-1)?.role).toBe("assistant");
    expect(detachedSnapshot.modelMessages.at(-1)?.content).toContain("worker 分支总结");
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

    const resumed = await new SessionService(root).initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
      resumeSessionId: forked.head.sessionId,
    });

    expect(resumed.snapshot.sessionId).toBe(forked.head.sessionId);
    expect(resumed.snapshot.shellCwd).toBe("/tmp/project/worker-a");
    expect(resumed.ref.workingHeadId).toBe(forked.head.id);
    expect(resumed.head.name).toBe("worker-a");
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
      lastUserPrompt: "旧版主会话",
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
      lastUserPrompt: "旧版附加会话",
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
  it("两个服务实例分别创建分支时会保留完整 branch 元数据", async () => {
    const root = await makeTempDir("qagent-session-concurrent-branches-");
    const seed = new SessionService(root);
    const initialized = await seed.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    const worker = await seed.forkHead("worker-b", {
      sourceHeadId: initialized.head.id,
      activate: false,
    });
    await (seed as unknown as { dispose?: () => Promise<void> }).dispose?.();

    const serviceA = new SessionService(root);
    const serviceB = new SessionService(root);
    const mainHead = await serviceA.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    const workerHead = await serviceB.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
      resumeSessionId: worker.head.sessionId,
    });

    await serviceA.createBranch("branch-a", mainHead.snapshot);
    await serviceB.createBranch("branch-b", workerHead.snapshot);

    const refs = await new SessionService(root).listRefs();

    expect(refs.branches.map((branch) => branch.name)).toEqual(
      expect.arrayContaining(["main", "branch-a", "branch-b"]),
    );
  });

  it("第二个实例初始化同一个 working head 时会被拒绝", async () => {
  const root = await makeTempDir("qagent-session-head-lock-");
    const serviceA = new SessionService(root);
    await serviceA.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    await expect(
      new SessionService(root).initialize({
        cwd: "/tmp/project",
        shellCwd: "/tmp/project",
        approvalMode: "always",
      }),
    ).rejects.toThrow(/working head/i);
  });
});
