import type {
  SessionAssetProvider,
  SessionNode,
  SessionSnapshot,
  SessionWorkingHead,
} from "../../types.js";
import {
  cloneSnapshotForHead,
  normalizeSessionSnapshot,
} from "../domain/sessionDomain.js";
import type { SessionGraphStore } from "../sessionGraphStore.js";
import type { SessionStore } from "../sessionStore.js";

interface AssetOverlayServiceInput {
  sessionRoot: string;
  assetProviders: SessionAssetProvider[];
  sessionStore: SessionStore;
  graphStore: SessionGraphStore;
  ensureRepoLoaded: () => Promise<void>;
  requireHead: (headId: string) => Promise<SessionWorkingHead>;
  requireNode: (nodeId: string) => Promise<SessionNode>;
}

export class AssetOverlayService {
  public constructor(private readonly input: AssetOverlayServiceInput) {}

  public async runForkProviders(
    head: SessionWorkingHead,
    snapshot: SessionSnapshot,
    sourceHead?: SessionWorkingHead,
  ): Promise<Record<string, unknown>> {
    const nextState: Record<string, unknown> = {};
    for (const provider of this.input.assetProviders) {
      nextState[provider.kind] = await provider.fork({
        head,
        sessionRoot: this.input.sessionRoot,
        snapshot,
        sourceHead,
        sourceState: sourceHead?.assetState[provider.kind],
      });
    }
    return nextState;
  }

  public async runCheckpointProviders(
    head: SessionWorkingHead,
    snapshot: SessionSnapshot,
  ): Promise<Record<string, unknown>> {
    const nextState: Record<string, unknown> = {
      ...head.assetState,
    };
    for (const provider of this.input.assetProviders) {
      nextState[provider.kind] = await provider.checkpoint({
        head,
        state: head.assetState[provider.kind],
        snapshot,
        sessionRoot: this.input.sessionRoot,
      });
    }
    return nextState;
  }

  public async restoreProviders(head: SessionWorkingHead): Promise<void> {
    for (const provider of this.input.assetProviders) {
      if (!provider.restore) {
        continue;
      }
      await provider.restore({
        head,
        state: head.assetState[provider.kind],
        sessionRoot: this.input.sessionRoot,
      });
    }
  }

  public async loadWorkingSnapshot(headId: string): Promise<SessionSnapshot> {
    await this.input.ensureRepoLoaded();
    const head = await this.input.requireHead(headId);
    const current = await this.input.sessionStore.load(head.id);
    if (current) {
      const normalized = normalizeSessionSnapshot(current, {
        headId: head.id,
        sessionId: head.sessionId,
        fallbackTime: current.updatedAt,
        uiContextEnabled: head.runtimeState.uiContextEnabled ?? false,
      });
      if (JSON.stringify(current) !== JSON.stringify(normalized)) {
        await this.input.sessionStore.saveSnapshot(normalized);
      }
      await this.restoreProviders(head);
      return normalized;
    }

    const node = await this.input.requireNode(head.currentNodeId);
    const restored = cloneSnapshotForHead(node.snapshot, head);
    restored.shellCwd = head.runtimeState.shellCwd || restored.shellCwd;
    await this.input.sessionStore.saveSnapshot(restored);
    await this.restoreProviders(head);
    return restored;
  }
}
