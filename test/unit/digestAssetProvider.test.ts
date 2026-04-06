import { describe, expect, it } from "vitest";

import { createDigestSessionAssetProvider } from "../../src/session/index.js";
import type {
  SessionAssetCheckpointInput,
  SessionAssetForkInput,
  SessionAssetMergeInput,
  SessionSnapshot,
  SessionWorkingHead,
} from "../../src/types.js";

function createHead(id: string, name: string): SessionWorkingHead {
  const now = new Date().toISOString();
  return {
    id,
    name,
    currentNodeId: `node-${id}`,
    sessionId: `session-${id}`,
    attachment: {
      mode: "detached-node",
      name: `node-${id}`,
      nodeId: `node-${id}`,
    },
    runtimeState: {
      shellCwd: "/tmp/project",
      agentKind: "interactive",
      autoMemoryFork: true,
      retainOnCompletion: true,
      status: "idle",
    },
    assetState: {},
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function createSnapshot(id: string, user: string, assistant: string): SessionSnapshot {
  const now = new Date().toISOString();
  return {
    workingHeadId: id,
    sessionId: `session-${id}`,
    createdAt: now,
    updatedAt: now,
    cwd: "/tmp/project",
    shellCwd: "/tmp/project",
    approvalMode: "always",
    uiMessages: [],
    modelMessages: [
      {
        id: `user-${id}`,
        role: "user",
        content: user,
        createdAt: now,
      },
      {
        id: `assistant-${id}`,
        role: "assistant",
        content: assistant,
        createdAt: now,
      },
    ],
    lastUserPrompt: user,
  };
}

describe("digestAssetProvider", () => {
  it("provider kind 为 digest，并在 merge 时生成 digest 资产", async () => {
    const provider = createDigestSessionAssetProvider();
    const targetHead = createHead("target", "main");
    const sourceHead = createHead("source", "worker");
    const targetSnapshot = createSnapshot("target", "整理主线", "主线已完成");
    const sourceSnapshot = createSnapshot("source", "补充记忆", "worker 已补充");

    const targetState = await provider.fork({
      head: targetHead,
      sessionRoot: "/tmp/session",
      snapshot: targetSnapshot,
    } satisfies SessionAssetForkInput);
    const sourceState = await provider.checkpoint({
      head: sourceHead,
      state: undefined,
      snapshot: sourceSnapshot,
      sessionRoot: "/tmp/session",
    } satisfies SessionAssetCheckpointInput);
    const merged = await provider.merge({
      targetHead,
      sourceHead,
      targetState,
      sourceState,
      targetSnapshot,
      sourceSnapshot,
      sessionRoot: "/tmp/session",
    } satisfies SessionAssetMergeInput);

    expect(provider.kind).toBe("digest");
    expect(merged.mergeAssets?.[0]?.title).toBe("merge:worker");
    expect(merged.mergeAssets?.[0]?.tags).toContain("digest");
  });
});
