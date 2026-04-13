import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SessionLockService,
  SessionLockWaitTimeoutError,
} from "../../src/session/index.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("SessionLockService", () => {
  it("首个 process lease 能获取，第二个活跃持有者会被拒绝", async () => {
    const root = await makeTempDir("qagent-session-lock-");
    const first = new SessionLockService(root, {
      ownerKind: "first",
      processLeaseHeartbeatMs: 20,
      processLeaseTtlMs: 200,
      mutationHeartbeatMs: 20,
      mutationTtlMs: 200,
      mutationPollMs: 10,
    });
    const second = new SessionLockService(root, {
      ownerKind: "second",
      processLeaseHeartbeatMs: 20,
      processLeaseTtlMs: 200,
      mutationHeartbeatMs: 20,
      mutationTtlMs: 200,
      mutationPollMs: 10,
    });

    await first.ensureProcessLease();
    await expect(second.ensureProcessLease()).rejects.toThrow(/owner=first/);

    await first.dispose();
    await expect(second.ensureProcessLease()).resolves.toBeUndefined();
    await second.dispose();
  });

  it("stale process lease 过期后可被接管", async () => {
    const root = await makeTempDir("qagent-session-lock-stale-");
    const first = new SessionLockService(root, {
      ownerKind: "stale-holder",
      processLeaseHeartbeatMs: 100,
      processLeaseTtlMs: 20,
      mutationHeartbeatMs: 5,
      mutationTtlMs: 20,
      mutationPollMs: 5,
    });
    const second = new SessionLockService(root, {
      ownerKind: "next-holder",
      processLeaseHeartbeatMs: 100,
      processLeaseTtlMs: 20,
      mutationHeartbeatMs: 5,
      mutationTtlMs: 20,
      mutationPollMs: 5,
    });

    await first.ensureProcessLease();
    await sleep(35);
    await expect(second.ensureProcessLease()).resolves.toBeUndefined();

    await first.dispose();
    await second.dispose();
  });

  it("heartbeat 读取异常会走错误回调而不是未处理 rejection", async () => {
    const root = await makeTempDir("qagent-session-lock-heartbeat-");
    const heartbeatErrors: unknown[] = [];
    const service = new SessionLockService(root, {
      ownerKind: "heartbeat-holder",
      processLeaseHeartbeatMs: 20,
      processLeaseTtlMs: 200,
      mutationHeartbeatMs: 5,
      mutationTtlMs: 200,
      mutationPollMs: 5,
      onHeartbeatError: (error) => {
        heartbeatErrors.push(error);
      },
    });

    const handle = await service.acquireRepoMutationLock();
    const metadataPath = path.join(root, "__locks", "repo-mutation", "lease.json");
    await writeFile(metadataPath, "{", "utf8");
    await sleep(50);

    expect(heartbeatErrors.length).toBeGreaterThan(0);

    await writeFile(metadataPath, JSON.stringify(handle.metadata), "utf8");
    await handle.release();
  });

  it("空锁目录达到宽限期后会被自动清理并重新获取", async () => {
    const root = await makeTempDir("qagent-session-lock-orphaned-");
    const lockDir = path.join(root, "__locks", "repo-mutation");
    await mkdir(lockDir, { recursive: true });
    const staleDate = new Date(Date.now() - 2_000);
    await utimes(lockDir, staleDate, staleDate);
    const service = new SessionLockService(root, {
      ownerKind: "orphan-recovery",
      processLeaseHeartbeatMs: 20,
      processLeaseTtlMs: 200,
      mutationHeartbeatMs: 20,
      mutationTtlMs: 200,
      mutationPollMs: 10,
    });

    const handle = await service.acquireRepoMutationLock();

    expect(handle.metadata.lockName).toBe("repo-mutation");
    await handle.release();
    await service.dispose();
  });

  it("等待型锁超过超时时间会抛出带诊断信息的错误", async () => {
    const root = await makeTempDir("qagent-session-lock-timeout-");
    const first = new SessionLockService(root, {
      ownerKind: "holder",
      processLeaseHeartbeatMs: 20,
      processLeaseTtlMs: 200,
      mutationHeartbeatMs: 20,
      mutationTtlMs: 200,
      mutationPollMs: 10,
      mutationWaitTimeoutMs: 60,
    });
    const second = new SessionLockService(root, {
      ownerKind: "waiter",
      processLeaseHeartbeatMs: 20,
      processLeaseTtlMs: 200,
      mutationHeartbeatMs: 20,
      mutationTtlMs: 200,
      mutationPollMs: 10,
      mutationWaitTimeoutMs: 60,
    });

    const handle = await first.acquireRepoMutationLock();

    await expect(second.acquireRepoMutationLock()).rejects.toMatchObject({
      name: "SessionLockWaitTimeoutError",
      lockName: "repo-mutation",
      metadata: expect.objectContaining({
        ownerKind: "holder",
        lockName: "repo-mutation",
      }),
    } satisfies Partial<SessionLockWaitTimeoutError>);

    await handle.release();
    await first.dispose();
    await second.dispose();
  });
});
