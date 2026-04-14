import { describe, expect, it, vi } from "vitest";

import { AgentManager } from "../../src/runtime/agentManager.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("AgentManager", () => {
  it("同一 auto-memory sourceHash 只会入队一次 post-run job", async () => {
    const runPostRunJob = vi.fn(async () => {
      await sleep(20);
    });
    const manager = Object.create(AgentManager.prototype) as {
      enqueuePostRunJobs(runtime: { agentId: string }): void;
      hookPipeline: {
        collectPostRunJobs(runtime: { agentId: string }): Array<{
          kind: "auto-memory-fork";
          agentId: string;
          sourceHash: string;
          modelMessages: [];
        }>;
        runPostRunJob(job: unknown): Promise<void>;
      };
      pendingPostRunJobKeys: Set<string>;
      postRunJobs: Array<unknown>;
      drainingPostRunJobs: boolean;
      disposed: boolean;
      getPostRunJobKey: (job: { kind: string; agentId: string; sourceHash?: string }) => string;
      drainPostRunJobs: () => Promise<void>;
      handlePostRunJobFailure: (job: unknown, error: unknown) => Promise<void>;
    };

    Object.assign(manager, {
      hookPipeline: {
        collectPostRunJobs: () => [{
          kind: "auto-memory-fork" as const,
          agentId: "executor_1",
          sourceHash: "hash_1",
          modelMessages: [],
        }],
        runPostRunJob,
      },
      pendingPostRunJobKeys: new Set<string>(),
      postRunJobs: [],
      drainingPostRunJobs: false,
      disposed: false,
      getPostRunJobKey: (AgentManager.prototype as unknown as {
        getPostRunJobKey: (job: {
          kind: string;
          agentId: string;
          sourceHash?: string;
        }) => string;
      }).getPostRunJobKey,
      drainPostRunJobs: (AgentManager.prototype as unknown as {
        drainPostRunJobs: () => Promise<void>;
      }).drainPostRunJobs,
      handlePostRunJobFailure: vi.fn(async () => {}),
    });

    manager.enqueuePostRunJobs = (AgentManager.prototype as unknown as {
      enqueuePostRunJobs: (runtime: { agentId: string }) => void;
    }).enqueuePostRunJobs;

    manager.enqueuePostRunJobs({ agentId: "executor_1" });
    manager.enqueuePostRunJobs({ agentId: "executor_1" });

    await sleep(50);

    expect(runPostRunJob).toHaveBeenCalledTimes(1);
    expect(manager.pendingPostRunJobKeys.size).toBe(0);
    expect(manager.postRunJobs).toHaveLength(0);
  });
});
