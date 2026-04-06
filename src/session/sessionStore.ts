import path from "node:path";
import { readdir } from "node:fs/promises";

import type { ApprovalMode, SessionEvent, SessionSnapshot } from "../types.js";
import {
  appendNdjson,
  createId,
  ensureDir,
  readJsonIfExists,
  writeJson,
} from "../utils/index.js";

interface InitializeSessionInput {
  sessionId?: string;
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
}

export class SessionStore {
  public constructor(private readonly sessionRoot: string) {}

  public async initializeSession(
    input: InitializeSessionInput,
  ): Promise<SessionSnapshot> {
    await ensureDir(this.sessionRoot);

    if (input.sessionId) {
      const existing = await this.load(input.sessionId);
      if (existing) {
        return existing;
      }
    }

    const sessionId = input.sessionId ?? createId("session");
    const now = new Date().toISOString();
    const snapshot: SessionSnapshot = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      cwd: input.cwd,
      shellCwd: input.shellCwd,
      approvalMode: input.approvalMode,
      uiMessages: [],
      modelMessages: [],
    };
    await this.saveSnapshot(snapshot);
    await this.appendEvent({
      id: createId("event"),
      sessionId,
      type: "session.created",
      timestamp: now,
      payload: {
        cwd: input.cwd,
        shellCwd: input.shellCwd,
      },
    });

    return snapshot;
  }

  public async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    const snapshotPath = this.getSnapshotPath(sessionId);
    return readJsonIfExists<SessionSnapshot>(snapshotPath);
  }

  public async loadMostRecent(): Promise<SessionSnapshot | undefined> {
    await ensureDir(this.sessionRoot);

    const sessionDirs = await readdir(this.sessionRoot, { withFileTypes: true });
    const snapshots = await Promise.all(
      sessionDirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          return this.load(entry.name);
        }),
    );

    return snapshots
      .filter((snapshot): snapshot is SessionSnapshot => Boolean(snapshot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  public async appendEvent(event: SessionEvent): Promise<void> {
    const logPath = this.getEventLogPath(event.sessionId);
    await appendNdjson(logPath, event);
  }

  public async saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
    const sessionDir = this.getSessionDir(snapshot.sessionId);
    await ensureDir(sessionDir);
    const nextSnapshot: SessionSnapshot = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.getSnapshotPath(snapshot.sessionId), nextSnapshot);
  }

  private getSessionDir(sessionId: string): string {
    return path.join(this.sessionRoot, sessionId);
  }

  private getSnapshotPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), "snapshot.json");
  }

  private getEventLogPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), "events.ndjson");
  }
}
