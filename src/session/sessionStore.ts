import { readdir } from "node:fs/promises";
import path from "node:path";

import type { ApprovalMode, SessionEvent, SessionSnapshot } from "../types.js";
import {
  appendNdjson,
  createId,
  ensureDir,
  readJsonIfExists,
  writeJson,
} from "../utils/index.js";

interface InitializeHeadSessionInput {
  workingHeadId: string;
  sessionId?: string;
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
}

export class SessionStore {
  public constructor(private readonly sessionRoot: string) {}

  public async initializeHeadSession(
    input: InitializeHeadSessionInput,
  ): Promise<SessionSnapshot> {
    await ensureDir(this.getHeadsRoot());

    const existing = await this.load(input.workingHeadId);
    if (existing) {
      return existing;
    }

    const sessionId = input.sessionId ?? createId("session");
    const now = new Date().toISOString();
    const snapshot: SessionSnapshot = {
      workingHeadId: input.workingHeadId,
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
      workingHeadId: input.workingHeadId,
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

  public async load(workingHeadId: string): Promise<SessionSnapshot | undefined> {
    return readJsonIfExists<SessionSnapshot>(this.getSnapshotPath(workingHeadId));
  }

  public async loadMostRecent(): Promise<SessionSnapshot | undefined> {
    await ensureDir(this.getHeadsRoot());

    const headDirs = await readdir(this.getHeadsRoot(), { withFileTypes: true });
    const snapshots = await Promise.all(
      headDirs
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
    await appendNdjson(this.getEventLogPath(event.workingHeadId), event);
  }

  public async saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
    await ensureDir(this.getHeadDir(snapshot.workingHeadId));
    await writeJson(this.getSnapshotPath(snapshot.workingHeadId), {
      ...snapshot,
      updatedAt: new Date().toISOString(),
    });
  }

  private getHeadsRoot(): string {
    return path.join(this.sessionRoot, "__heads");
  }

  private getHeadDir(workingHeadId: string): string {
    return path.join(this.getHeadsRoot(), workingHeadId);
  }

  private getSnapshotPath(workingHeadId: string): string {
    return path.join(this.getHeadDir(workingHeadId), "snapshot.json");
  }

  private getEventLogPath(workingHeadId: string): string {
    return path.join(this.getHeadDir(workingHeadId), "events.ndjson");
  }
}
