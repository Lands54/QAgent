import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
  ApprovalMode,
  PendingApprovalCheckpoint,
  SessionEvent,
  SessionSnapshot,
} from "../types.js";
import {
  normalizeSessionSnapshot,
} from "./domain/sessionDomain.js";
import { createSessionCreatedEvent } from "./domain/sessionEvents.js";
import {
  appendNdjson,
  createId,
  ensureDir,
  readJsonIfExists,
  writeJson,
} from "../utils/index.js";

async function readSessionJsonIfExists<T>(
  targetPath: string,
): Promise<T | undefined> {
  try {
    return await readJsonIfExists<T>(targetPath);
  } catch {
    return undefined;
  }
}

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
      conversationEntries: [],
      uiMessages: [],
      modelMessages: [],
    };
    await this.saveSnapshot(snapshot);
    await this.appendEvent(
      createSessionCreatedEvent({
        workingHeadId: input.workingHeadId,
        sessionId,
        timestamp: now,
        cwd: input.cwd,
        shellCwd: input.shellCwd,
      }),
    );

    return snapshot;
  }

  public async load(workingHeadId: string): Promise<SessionSnapshot | undefined> {
    const snapshot = await readSessionJsonIfExists<SessionSnapshot>(
      this.getSnapshotPath(workingHeadId),
    );
    if (!snapshot) {
      return undefined;
    }
    return normalizeSessionSnapshot(snapshot, {
      headId: workingHeadId,
      sessionId: snapshot.sessionId,
      fallbackTime: snapshot.updatedAt ?? snapshot.createdAt ?? new Date().toISOString(),
      uiContextEnabled: false,
    });
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

  public async loadPendingApprovalCheckpoint(
    workingHeadId: string,
  ): Promise<PendingApprovalCheckpoint | undefined> {
    const checkpoint = await readSessionJsonIfExists<PendingApprovalCheckpoint>(
      this.getPendingApprovalCheckpointPath(workingHeadId),
    );
    if (!checkpoint) {
      return undefined;
    }
    return {
      ...checkpoint,
      worklineId: checkpoint.worklineId ?? checkpoint.headId,
      executorId: checkpoint.executorId ?? checkpoint.agentId,
    };
  }

  public async savePendingApprovalCheckpoint(
    workingHeadId: string,
    checkpoint: PendingApprovalCheckpoint,
  ): Promise<void> {
    await ensureDir(this.getHeadDir(workingHeadId));
    await writeJson(this.getPendingApprovalCheckpointPath(workingHeadId), checkpoint);
  }

  public async clearPendingApprovalCheckpoint(
    workingHeadId: string,
  ): Promise<void> {
    await rm(this.getPendingApprovalCheckpointPath(workingHeadId), {
      force: true,
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

  private getPendingApprovalCheckpointPath(workingHeadId: string): string {
    return path.join(this.getHeadDir(workingHeadId), "pending-approval.json");
  }
}
