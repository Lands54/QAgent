import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { projectSnapshotConversationEntries } from "../../src/session/domain/sessionDomain.js";
import { SessionStore } from "../../src/session/sessionStore.js";
import { createId } from "../../src/utils/ids.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("SessionStore", () => {
  it("能初始化、保存并恢复会话快照", async () => {
    const root = await makeTempDir("qagent-session-");
    const store = new SessionStore(root);
    const snapshot = await store.initializeHeadSession({
      workingHeadId: "head_demo",
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    await store.saveSnapshot(
      projectSnapshotConversationEntries(
        {
          ...snapshot,
          uiMessages: [
            {
              id: createId("ui"),
              role: "user",
              content: "hello",
              createdAt: new Date().toISOString(),
            },
          ],
        },
        false,
      ),
    );

    const loaded = await store.load(snapshot.workingHeadId);
    const latest = await store.loadMostRecent();
    const snapshotPath = path.join(root, "__heads", snapshot.workingHeadId, "snapshot.json");
    const rawSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(loaded?.sessionId).toBe(snapshot.sessionId);
    expect(loaded?.workingHeadId).toBe(snapshot.workingHeadId);
    expect(loaded?.uiMessages[0]?.content).toBe("hello");
    expect(latest?.sessionId).toBe(snapshot.sessionId);
    expect(rawSnapshot).not.toHaveProperty("activeSkillIds");
  });

  it("loadMostRecent 会跳过损坏的 snapshot JSON", async () => {
    const root = await makeTempDir("qagent-session-corrupt-");
    const store = new SessionStore(root);
    const valid = await store.initializeHeadSession({
      workingHeadId: "head_valid",
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    await store.initializeHeadSession({
      workingHeadId: "head_bad",
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });
    await writeFile(
      path.join(root, "__heads", "head_bad", "snapshot.json"),
      "{",
      "utf8",
    );

    await expect(store.load("head_bad")).resolves.toBeUndefined();
    await expect(store.loadMostRecent()).resolves.toMatchObject({
      workingHeadId: valid.workingHeadId,
    });
  });
});
