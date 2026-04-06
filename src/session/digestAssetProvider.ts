import type {
  SessionAbstractAsset,
  SessionAssetCheckpointInput,
  SessionAssetForkInput,
  SessionAssetMergeInput,
  SessionAssetMergeResult,
  SessionAssetProvider,
  SessionSnapshot,
} from "../types.js";
import { createId, firstLine, truncate } from "../utils/index.js";

interface DigestState {
  user: string;
  assistant: string;
  tool: string;
  updatedAt: string;
}

function digestContentFromSnapshot(snapshot: SessionSnapshot): DigestState {
  const lastAssistant = [...snapshot.modelMessages]
    .reverse()
    .find((message) => {
      return message.role === "assistant" && message.content.trim().length > 0;
    });
  const lastTool = [...snapshot.modelMessages]
    .reverse()
    .find((message) => message.role === "tool");

  return {
    user: firstLine(snapshot.lastUserPrompt ?? "", "无"),
    assistant: firstLine(lastAssistant?.content ?? "", "无"),
    tool: firstLine(lastTool?.content ?? "", "无"),
    updatedAt: new Date().toISOString(),
  };
}

export function buildNodeDigestAsset(
  kind: "root" | "checkpoint" | "compact",
  nodeId: string,
  digest: DigestState,
  sourceNodeIds: string[],
): SessionAbstractAsset {
  return {
    id: createId("asset"),
    title: `${kind}:${nodeId}`,
    content: [
      `user: ${digest.user}`,
      `assistant: ${truncate(digest.assistant, 160)}`,
      `shell: ${truncate(digest.tool, 160)}`,
    ].join("\n"),
    tags: [kind, "digest"],
    sourceNodeIds,
    createdAt: new Date().toISOString(),
  };
}

function buildMergeDigestAsset(
  sourceRef: string,
  currentDigest: DigestState,
  sourceDigest: DigestState,
  sourceNodeIds: string[],
): SessionAbstractAsset {
  return {
    id: createId("asset"),
    title: `merge:${sourceRef}`,
    content: [
      `merged_at: ${new Date().toISOString()}`,
      `current: user=${currentDigest.user} | assistant=${truncate(currentDigest.assistant, 120)} | shell=${truncate(currentDigest.tool, 120)}`,
      `source: user=${sourceDigest.user} | assistant=${truncate(sourceDigest.assistant, 120)} | shell=${truncate(sourceDigest.tool, 120)}`,
    ].join("\n"),
    tags: ["merge", "digest"],
    sourceNodeIds,
    createdAt: new Date().toISOString(),
  };
}

export function createDigestSessionAssetProvider(): SessionAssetProvider {
  return {
    kind: "digest",
    async fork(input: SessionAssetForkInput): Promise<unknown> {
      if (input.sourceState) {
        return input.sourceState;
      }
      return digestContentFromSnapshot(input.snapshot);
    },
    async checkpoint(input: SessionAssetCheckpointInput): Promise<unknown> {
      return digestContentFromSnapshot(input.snapshot);
    },
    async merge(input: SessionAssetMergeInput): Promise<SessionAssetMergeResult> {
      const currentDigest = (input.targetState as DigestState | undefined)
        ?? digestContentFromSnapshot(input.targetSnapshot);
      const sourceDigest = (input.sourceState as DigestState | undefined)
        ?? digestContentFromSnapshot(input.sourceSnapshot);

      return {
        targetState: {
          ...currentDigest,
          updatedAt: new Date().toISOString(),
        },
        mergeAssets: [
          buildMergeDigestAsset(
            input.sourceHead.name,
            currentDigest,
            sourceDigest,
            [input.targetHead.currentNodeId, input.sourceHead.currentNodeId],
          ),
        ],
      };
    },
  };
}
