import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { createId, ensureDir, readJsonIfExists, writeJson } from "../utils/index.js";

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_TTL_MS = 20_000;
const DEFAULT_POLL_MS = 50;

interface SessionLockMetadata {
  leaseId: string;
  pid: number;
  ownerKind: string;
  lockKind: "process" | "repo-mutation" | "head-mutation";
  lockName: string;
  headId?: string;
  startedAt: string;
  lastHeartbeatAt: string;
}

interface AcquireSessionLockInput {
  lockName: string;
  lockKind: SessionLockMetadata["lockKind"];
  headId?: string;
  wait: boolean;
  heartbeatMs: number;
  ttlMs: number;
  pollMs: number;
}

export interface SessionServiceLockOptions {
  ownerKind: string;
  processLeaseHeartbeatMs?: number;
  processLeaseTtlMs?: number;
  mutationHeartbeatMs?: number;
  mutationTtlMs?: number;
  mutationPollMs?: number;
}

export interface SessionLockHandle {
  readonly metadata: Readonly<SessionLockMetadata>;
  release(): Promise<void>;
}

export class SessionLockBusyError extends Error {
  public constructor(
    public readonly lockName: string,
    public readonly metadata: Readonly<SessionLockMetadata>,
  ) {
    super(buildBusyMessage(lockName, metadata));
    this.name = "SessionLockBusyError";
  }
}

function buildBusyMessage(
  lockName: string,
  metadata: Readonly<SessionLockMetadata>,
): string {
  const headInfo = metadata.headId ? ` head=${metadata.headId}` : "";
  return [
    `session lock ${lockName} 当前已被占用。`,
    `owner=${metadata.ownerKind}${headInfo}`,
    `pid=${metadata.pid}`,
    `startedAt=${metadata.startedAt}`,
    `lastHeartbeatAt=${metadata.lastHeartbeatAt}`,
  ].join(" ");
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class SessionLockService {
  private readonly locksRoot: string;
  private processLease?: SessionLockHandle;

  public constructor(
    private readonly sessionRoot: string,
    private readonly options: SessionServiceLockOptions,
  ) {
    this.locksRoot = path.join(sessionRoot, "__locks");
  }

  public async ensureProcessLease(): Promise<void> {
    if (this.processLease) {
      return;
    }
    this.processLease = await this.acquireLock({
      lockName: "process",
      lockKind: "process",
      wait: false,
      heartbeatMs: this.options.processLeaseHeartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      ttlMs: this.options.processLeaseTtlMs ?? DEFAULT_TTL_MS,
      pollMs: this.options.mutationPollMs ?? DEFAULT_POLL_MS,
    });
  }

  public async acquireRepoMutationLock(): Promise<SessionLockHandle> {
    return this.acquireLock({
      lockName: "repo-mutation",
      lockKind: "repo-mutation",
      wait: true,
      heartbeatMs: this.options.mutationHeartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      ttlMs: this.options.mutationTtlMs ?? DEFAULT_TTL_MS,
      pollMs: this.options.mutationPollMs ?? DEFAULT_POLL_MS,
    });
  }

  public async acquireHeadMutationLock(headId: string): Promise<SessionLockHandle> {
    return this.acquireLock({
      lockName: `head-${headId}-mutation`,
      lockKind: "head-mutation",
      headId,
      wait: true,
      heartbeatMs: this.options.mutationHeartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      ttlMs: this.options.mutationTtlMs ?? DEFAULT_TTL_MS,
      pollMs: this.options.mutationPollMs ?? DEFAULT_POLL_MS,
    });
  }

  public async dispose(): Promise<void> {
    await this.processLease?.release();
    this.processLease = undefined;
  }

  private async acquireLock(input: AcquireSessionLockInput): Promise<SessionLockHandle> {
    await ensureDir(this.locksRoot);
    const lockDir = path.join(this.locksRoot, input.lockName);
    const metadata: SessionLockMetadata = {
      leaseId: createId("lease"),
      pid: process.pid,
      ownerKind: this.options.ownerKind,
      lockKind: input.lockKind,
      lockName: input.lockName,
      headId: input.headId,
      startedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
    };

    while (true) {
      try {
        await mkdir(lockDir);
        await this.writeMetadata(lockDir, metadata);
        return this.createHandle(lockDir, metadata, input.heartbeatMs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        const existing = await this.readMetadata(lockDir);
        if (!existing) {
          await sleep(input.pollMs);
          continue;
        }
        if (existing && !this.isStale(existing, input.ttlMs)) {
          if (!input.wait) {
            throw new SessionLockBusyError(input.lockName, existing);
          }
          await sleep(input.pollMs);
          continue;
        }

        await this.removeLockDir(lockDir);
      }
    }
  }

  private createHandle(
    lockDir: string,
    metadata: SessionLockMetadata,
    heartbeatMs: number,
  ): SessionLockHandle {
    let released = false;
    const timer = setInterval(() => {
      void this.heartbeat(lockDir, metadata);
    }, heartbeatMs);
    timer.unref?.();

    return {
      metadata,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        clearInterval(timer);
        const current = await this.readMetadata(lockDir);
        if (current?.leaseId !== metadata.leaseId) {
          return;
        }
        await this.removeLockDir(lockDir);
      },
    };
  }

  private async heartbeat(
    lockDir: string,
    metadata: SessionLockMetadata,
  ): Promise<void> {
    try {
      const current = await this.readMetadata(lockDir);
      if (!current || current.leaseId !== metadata.leaseId) {
        return;
      }
      await this.writeMetadata(lockDir, {
        ...current,
        lastHeartbeatAt: nowIso(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async readMetadata(
    lockDir: string,
  ): Promise<SessionLockMetadata | undefined> {
    return readJsonIfExists<SessionLockMetadata>(path.join(lockDir, "lease.json"));
  }

  private async writeMetadata(
    lockDir: string,
    metadata: SessionLockMetadata,
  ): Promise<void> {
    await writeJson(path.join(lockDir, "lease.json"), metadata);
  }

  private async removeLockDir(lockDir: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(lockDir, {
          recursive: true,
          force: true,
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
          throw error;
        }
        await sleep(10);
      }
    }
  }

  private isStale(
    metadata: Readonly<SessionLockMetadata>,
    ttlMs: number,
  ): boolean {
    return Date.now() - Date.parse(metadata.lastHeartbeatAt) > ttlMs;
  }
}
