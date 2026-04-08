import { open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import type {
  SessionBranchRef,
  SessionNode,
  SessionRepoState,
  SessionTagRef,
  SessionWorkingHead,
} from "../types.js";
import { ensureDir, pathExists, readJsonIfExists, writeJson } from "../utils/index.js";

interface SessionLockMetadata {
  clientId: string;
  pid: number;
  acquiredAt: string;
  updatedAt: string;
}

export interface SessionRepoLockHandle {
  path: string;
  metadata: SessionLockMetadata;
}

export interface SessionHeadLockHandle {
  headId: string;
  path: string;
  metadata: SessionLockMetadata;
}

export interface SessionHeadLockRecord extends SessionLockMetadata {
  headId: string;
}

export class SessionGraphStore {
  private readonly repoRoot: string;
  private readonly nodesRoot: string;
  private readonly headsRoot: string;
  private readonly locksRoot: string;
  private readonly headLocksRoot: string;
  private readonly repoLockPath: string;

  public constructor(private readonly sessionRoot: string) {
    this.repoRoot = path.join(sessionRoot, "__repo");
    this.nodesRoot = path.join(this.repoRoot, "nodes");
    this.headsRoot = path.join(this.repoRoot, "heads");
    this.locksRoot = path.join(this.repoRoot, "locks");
    this.headLocksRoot = path.join(this.locksRoot, "heads");
    this.repoLockPath = path.join(this.locksRoot, "repo.lock");
  }

  public async repoExists(): Promise<boolean> {
    return pathExists(this.getStatePath());
  }

  public async initializeRepo(input: {
    state: SessionRepoState;
    branches: SessionBranchRef[];
    tags: SessionTagRef[];
    nodes: SessionNode[];
    heads: SessionWorkingHead[];
  }): Promise<void> {
    await Promise.all([
      ensureDir(this.nodesRoot),
      ensureDir(this.headsRoot),
      ensureDir(this.headLocksRoot),
    ]);
    await this.saveState(input.state);
    await this.saveBranches(input.branches);
    await this.saveTags(input.tags);
    await Promise.all([
      ...input.nodes.map(async (node) => this.saveNode(node)),
      ...input.heads.map(async (head) => this.saveHead(head)),
    ]);
  }

  public async loadState(): Promise<SessionRepoState | undefined> {
    return readJsonIfExists<SessionRepoState>(this.getStatePath());
  }

  public async saveState(state: SessionRepoState): Promise<void> {
    await writeJson(this.getStatePath(), state);
  }

  public async loadBranches(): Promise<SessionBranchRef[]> {
    return (await readJsonIfExists<SessionBranchRef[]>(this.getBranchesPath())) ?? [];
  }

  public async saveBranches(branches: SessionBranchRef[]): Promise<void> {
    await writeJson(
      this.getBranchesPath(),
      [...branches].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  public async loadTags(): Promise<SessionTagRef[]> {
    return (await readJsonIfExists<SessionTagRef[]>(this.getTagsPath())) ?? [];
  }

  public async saveTags(tags: SessionTagRef[]): Promise<void> {
    await writeJson(
      this.getTagsPath(),
      [...tags].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  public async loadNode(nodeId: string): Promise<SessionNode | undefined> {
    return readJsonIfExists<SessionNode>(this.getNodePath(nodeId));
  }

  public async saveNode(node: SessionNode): Promise<void> {
    await writeJson(this.getNodePath(node.id), node);
  }

  public async listNodes(): Promise<SessionNode[]> {
    try {
      const entries = await readdir(this.nodesRoot, { withFileTypes: true });
      const nodes = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => {
            return this.loadNode(entry.name.replace(/\.json$/u, ""));
          }),
      );

      return nodes
        .filter((node): node is SessionNode => Boolean(node))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch {
      return [];
    }
  }

  public async loadHead(headId: string): Promise<SessionWorkingHead | undefined> {
    return readJsonIfExists<SessionWorkingHead>(this.getHeadPath(headId));
  }

  public async saveHead(head: SessionWorkingHead): Promise<void> {
    await writeJson(this.getHeadPath(head.id), head);
  }

  public async listHeads(): Promise<SessionWorkingHead[]> {
    try {
      const entries = await readdir(this.headsRoot, { withFileTypes: true });
      const heads = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => {
            return this.loadHead(entry.name.replace(/\.json$/u, ""));
          }),
      );

      return heads
        .filter((head): head is SessionWorkingHead => Boolean(head))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch {
      return [];
    }
  }

  public async acquireRepoLock(input: {
    clientId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<SessionRepoLockHandle> {
    const timeoutMs = input.timeoutMs ?? 5_000;
    const pollIntervalMs = input.pollIntervalMs ?? 50;
    const startedAt = Date.now();

    await ensureDir(this.locksRoot);

    while (true) {
      const metadata = this.createLockMetadata(input.clientId);
      try {
        const handle = await open(this.repoLockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(metadata, null, 2), "utf8");
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(this.repoLockPath).catch(() => undefined);
          throw error;
        }
        await handle.close();
        return {
          path: this.repoLockPath,
          metadata,
        };
      } catch (error) {
        if (this.isAlreadyExistsError(error)) {
          if (Date.now() - startedAt >= timeoutMs) {
            throw new Error("Timed out acquiring session repo lock.");
          }
          await this.delay(pollIntervalMs);
          continue;
        }
        throw error;
      }
    }
  }

  public async releaseRepoLock(handle: SessionRepoLockHandle): Promise<void> {
    const current = await readJsonIfExists<SessionLockMetadata>(handle.path);
    if (!current || current.clientId !== handle.metadata.clientId) {
      return;
    }
    await unlink(handle.path).catch(() => undefined);
  }

  public async readHeadLock(headId: string): Promise<SessionHeadLockRecord | undefined> {
    const lock = await readJsonIfExists<SessionLockMetadata>(this.getHeadLockPath(headId));
    if (!lock) {
      return undefined;
    }
    return {
      headId,
      ...lock,
    };
  }

  public async acquireHeadLock(
    headId: string,
    input: {
      clientId: string;
      staleAfterMs: number;
    },
  ): Promise<SessionHeadLockHandle> {
    const lockPath = this.getHeadLockPath(headId);
    await ensureDir(this.headLocksRoot);
    const existing = await readJsonIfExists<SessionLockMetadata>(lockPath);
    if (
      existing
      && existing.clientId !== input.clientId
      && !this.isLockStale(existing, input.staleAfterMs)
    ) {
      throw new Error(`working head ${headId} is already active in another client.`);
    }

    const metadata =
      existing && existing.clientId === input.clientId
        ? {
            ...existing,
            pid: process.pid,
            updatedAt: new Date().toISOString(),
          }
        : this.createLockMetadata(input.clientId);
    await writeJson(lockPath, metadata);
    return {
      headId,
      path: lockPath,
      metadata,
    };
  }

  public async refreshHeadLock(handle: SessionHeadLockHandle): Promise<void> {
    const current = await readJsonIfExists<SessionLockMetadata>(handle.path);
    if (!current || current.clientId !== handle.metadata.clientId) {
      throw new Error(`working head ${handle.headId} lock is no longer owned by this client.`);
    }
    const refreshed = {
      ...current,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(handle.path, refreshed);
    handle.metadata = refreshed;
  }

  public async releaseHeadLock(handle: SessionHeadLockHandle): Promise<void> {
    const current = await readJsonIfExists<SessionLockMetadata>(handle.path);
    if (!current || current.clientId !== handle.metadata.clientId) {
      return;
    }
    await unlink(handle.path).catch(() => undefined);
  }

  private getStatePath(): string {
    return path.join(this.repoRoot, "state.json");
  }

  private getBranchesPath(): string {
    return path.join(this.repoRoot, "branches.json");
  }

  private getTagsPath(): string {
    return path.join(this.repoRoot, "tags.json");
  }

  private getNodePath(nodeId: string): string {
    return path.join(this.nodesRoot, `${nodeId}.json`);
  }

  private getHeadPath(headId: string): string {
    return path.join(this.headsRoot, `${headId}.json`);
  }

  private getHeadLockPath(headId: string): string {
    return path.join(this.headLocksRoot, `${headId}.lock.json`);
  }

  private createLockMetadata(clientId: string): SessionLockMetadata {
    const now = new Date().toISOString();
    return {
      clientId,
      pid: process.pid,
      acquiredAt: now,
      updatedAt: now,
    };
  }

  private isAlreadyExistsError(error: unknown): boolean {
    return (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: string }).code === "EEXIST"
    );
  }

  private isLockStale(lock: SessionLockMetadata, staleAfterMs: number): boolean {
    const updatedAt = Date.parse(lock.updatedAt);
    if (Number.isNaN(updatedAt)) {
      return true;
    }
    return Date.now() - updatedAt > staleAfterMs;
  }

  private async delay(durationMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }
}
