import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { createId, ensureDir, readJsonIfExists, writeJson } from "../utils/index.js";

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_TTL_MS = 20_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const ORPHANED_LOCK_GRACE_MS = 1_000;

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
  waitTimeoutMs?: number;
}

export interface SessionServiceLockOptions {
  ownerKind: string;
  processLeaseHeartbeatMs?: number;
  processLeaseTtlMs?: number;
  mutationHeartbeatMs?: number;
  mutationTtlMs?: number;
  mutationPollMs?: number;
  mutationWaitTimeoutMs?: number;
  onHeartbeatError?: (
    error: unknown,
    metadata: Readonly<SessionLockMetadata>,
  ) => void;
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

export class SessionLockWaitTimeoutError extends Error {
  public constructor(
    public readonly lockName: string,
    public readonly waitMs: number,
    public readonly metadata?: Readonly<SessionLockMetadata>,
    public readonly orphanedLockAgeMs?: number,
  ) {
    super(buildWaitTimeoutMessage(lockName, waitMs, metadata, orphanedLockAgeMs));
    this.name = "SessionLockWaitTimeoutError";
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

function buildWaitTimeoutMessage(
  lockName: string,
  waitMs: number,
  metadata?: Readonly<SessionLockMetadata>,
  orphanedLockAgeMs?: number,
): string {
  const parts = [
    `等待 session lock ${lockName} 超时。`,
    `waitMs=${waitMs}`,
  ];
  if (metadata) {
    const headInfo = metadata.headId ? ` head=${metadata.headId}` : "";
    parts.push(
      `owner=${metadata.ownerKind}${headInfo}`,
      `pid=${metadata.pid}`,
      `startedAt=${metadata.startedAt}`,
      `lastHeartbeatAt=${metadata.lastHeartbeatAt}`,
    );
  }
  if (orphanedLockAgeMs !== undefined) {
    parts.push(`orphanedLockAgeMs=${Math.round(orphanedLockAgeMs)}`);
  }
  return parts.join(" ");
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
      waitTimeoutMs: this.options.mutationWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
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
      waitTimeoutMs: this.options.mutationWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
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
    const waitStartedAt = Date.now();

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
          const ageMs = await this.getLockDirAgeMs(lockDir);
          if (ageMs !== undefined && ageMs >= ORPHANED_LOCK_GRACE_MS) {
            await this.removeLockDir(lockDir);
            continue;
          }
          this.throwIfWaitTimedOut(input, waitStartedAt, undefined, ageMs);
          await sleep(input.pollMs);
          continue;
        }
        if (existing && !this.isStale(existing, input.ttlMs)) {
          if (!input.wait) {
            throw new SessionLockBusyError(input.lockName, existing);
          }
          this.throwIfWaitTimedOut(input, waitStartedAt, existing);
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
      void this.heartbeat(lockDir, metadata).catch((error: unknown) => {
        try {
          this.options.onHeartbeatError?.(error, metadata);
        } catch {
          // Heartbeat runs in the background and must not crash the owner.
        }
      });
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

  private throwIfWaitTimedOut(
    input: AcquireSessionLockInput,
    waitStartedAt: number,
    metadata?: Readonly<SessionLockMetadata>,
    orphanedLockAgeMs?: number,
  ): void {
    if (!input.wait || input.waitTimeoutMs === undefined) {
      return;
    }
    const waitMs = Date.now() - waitStartedAt;
    if (waitMs < input.waitTimeoutMs) {
      return;
    }
    throw new SessionLockWaitTimeoutError(
      input.lockName,
      waitMs,
      metadata,
      orphanedLockAgeMs,
    );
  }

  private async getLockDirAgeMs(lockDir: string): Promise<number | undefined> {
    try {
      const info = await stat(lockDir);
      return Date.now() - info.mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}
