import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../../src/session/sessionStore.js";
import { createId } from "../../src/utils/ids.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("SessionStore", () => {
  it("能初始化、保存并恢复会话快照", async () => {
    const root = await makeTempDir("qagent-session-");
    const store = new SessionStore(root);
    const snapshot = await store.initializeSession({
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
    });

    snapshot.uiMessages.push({
      id: createId("ui"),
      role: "user",
      content: "hello",
      createdAt: new Date().toISOString(),
    });
    await store.saveSnapshot(snapshot);

    const loaded = await store.load(snapshot.sessionId);
    const latest = await store.loadMostRecent();
    const snapshotPath = path.join(root, snapshot.sessionId, "snapshot.json");
    const rawSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(loaded?.sessionId).toBe(snapshot.sessionId);
    expect(loaded?.uiMessages[0]?.content).toBe("hello");
    expect(latest?.sessionId).toBe(snapshot.sessionId);
    expect(rawSnapshot).not.toHaveProperty("activeSkillIds");
  });
});
