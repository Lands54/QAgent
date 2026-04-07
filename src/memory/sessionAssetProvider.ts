import path from "node:path";

import type {
  SessionAssetCheckpointInput,
  SessionAssetForkInput,
  SessionAssetMergeInput,
  SessionAssetMergeResult,
  SessionAssetProvider,
} from "../types.js";
import {
  MemoryService,
  type MemoryDirectories,
  type MemoryForkWorkspace,
} from "./memoryService.js";
import { ensureDir } from "../utils/index.js";

interface MemoryAssetState {
  workspaceRoot: string;
  projectMemoryDir: string;
  globalMemoryDir: string;
}

function workspaceRootForHead(sessionRoot: string, headId: string): string {
  return path.join(sessionRoot, "__repo", "assets", "memory", headId);
}

function toWorkspace(state: MemoryAssetState): MemoryForkWorkspace {
  return {
    rootDir: state.workspaceRoot,
    projectMemoryDir: state.projectMemoryDir,
    globalMemoryDir: state.globalMemoryDir,
  };
}

function toDirectories(state: MemoryAssetState): MemoryDirectories {
  return {
    projectMemoryDir: state.projectMemoryDir,
    globalMemoryDir: state.globalMemoryDir,
  };
}

export function createMemorySessionAssetProvider(
  seedDirectories: MemoryDirectories,
): SessionAssetProvider {
  const baseMemory = new MemoryService(seedDirectories);

  return {
    kind: "memory",
    async fork(input: SessionAssetForkInput): Promise<unknown> {
      const sourceState = input.sourceState as MemoryAssetState | undefined;
      const workspaceRoot = workspaceRootForHead(input.sessionRoot, input.head.id);
      await ensureDir(workspaceRoot);
      const workspace = await baseMemory.createForkWorkspace({
        rootDir: workspaceRoot,
        sourceDirectories: sourceState ? toDirectories(sourceState) : seedDirectories,
      });
      return {
        workspaceRoot: workspace.rootDir,
        projectMemoryDir: workspace.projectMemoryDir,
        globalMemoryDir: workspace.globalMemoryDir,
      } satisfies MemoryAssetState;
    },
    async checkpoint(input: SessionAssetCheckpointInput): Promise<unknown> {
      return input.state;
    },
    async restore(): Promise<void> {},
    async merge(input: SessionAssetMergeInput): Promise<SessionAssetMergeResult> {
      const targetState = input.targetState as MemoryAssetState | undefined;
      const sourceState = input.sourceState as MemoryAssetState | undefined;
      if (!targetState || !sourceState) {
        return {
          targetState: input.targetState,
        };
      }

      await baseMemory.mergeForkWorkspace(
        toWorkspace(sourceState),
        toDirectories(targetState),
      );
      return {
        targetState,
      };
    },
  };
}
