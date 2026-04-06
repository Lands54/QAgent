import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SessionGraphStore, SessionService, SessionStore } from "../../src/session/index.js";
import type { LlmMessage, SessionSnapshot } from "../../src/types.js";
import { createId } from "../../src/utils/index.js";

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
    expect(mergeNode?.snapshot.modelMessages.at(-1)).toEqual(
      backToMain.snapshot.modelMessages.at(-1),
    );
    expect(mergeNode?.snapshot.modelMessages.at(-1)).not.toEqual(
      altSnapshot.modelMessages.at(-1),
    );
  });

  it("已有 repo 时，显式 resume 指定 legacy session 会导入为 detached node", async () => {
    const root = await makeTempDir("qagent-session-resume-");
    const service = new SessionService(root);
    await service.initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    const store = new SessionStore(root);
    const legacySnapshot = await store.initializeSession({
      sessionId: "session_legacy",
      cwd: "/tmp/project",
      shellCwd: "/tmp/project/legacy",
      approvalMode: "always",
    });
    const resumed = await new SessionService(root).initialize({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
      resumeSessionId: "session_legacy",
    });

    expect(resumed.snapshot.sessionId).toBe("session_legacy");
    expect(resumed.snapshot.shellCwd).toBe(legacySnapshot.shellCwd);
    expect(resumed.ref.mode).toBe("detached-node");
  });
});
