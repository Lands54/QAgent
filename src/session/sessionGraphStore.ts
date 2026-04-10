import { readdir } from "node:fs/promises";
import path from "node:path";

import type {
  SessionBranchRef,
  SessionCommitRecord,
  SessionNode,
  SessionRepoState,
  SessionTagRef,
  SessionWorkingHead,
} from "../types.js";
import { ensureDir, pathExists, readJsonIfExists, writeJson } from "../utils/index.js";

async function readSessionJsonIfExists<T>(
  targetPath: string,
): Promise<T | undefined> {
  try {
    return await readJsonIfExists<T>(targetPath);
  } catch {
    return undefined;
  }
}

export class SessionGraphStore {
  private readonly repoRoot: string;
  private readonly nodesRoot: string;
  private readonly headsRoot: string;

  public constructor(private readonly sessionRoot: string) {
    this.repoRoot = path.join(sessionRoot, "__repo");
    this.nodesRoot = path.join(this.repoRoot, "nodes");
    this.headsRoot = path.join(this.repoRoot, "heads");
  }

  public async repoExists(): Promise<boolean> {
    return pathExists(this.getStatePath());
  }

  public async initializeRepo(input: {
    state: SessionRepoState;
    branches: SessionBranchRef[];
    tags: SessionTagRef[];
    commits: SessionCommitRecord[];
    nodes: SessionNode[];
    heads: SessionWorkingHead[];
  }): Promise<void> {
    await Promise.all([ensureDir(this.nodesRoot), ensureDir(this.headsRoot)]);
    await this.saveState(input.state);
    await this.saveBranches(input.branches);
    await this.saveTags(input.tags);
    await this.saveCommits(input.commits);
    await Promise.all([
      ...input.nodes.map(async (node) => this.saveNode(node)),
      ...input.heads.map(async (head) => this.saveHead(head)),
    ]);
  }

  public async loadState(): Promise<SessionRepoState | undefined> {
    return readSessionJsonIfExists<SessionRepoState>(this.getStatePath());
  }

  public async saveState(state: SessionRepoState): Promise<void> {
    await writeJson(this.getStatePath(), state);
  }

  public async loadBranches(): Promise<SessionBranchRef[]> {
    return (
      await readSessionJsonIfExists<SessionBranchRef[]>(this.getBranchesPath())
    ) ?? [];
  }

  public async saveBranches(branches: SessionBranchRef[]): Promise<void> {
    await writeJson(
      this.getBranchesPath(),
      [...branches].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  public async loadTags(): Promise<SessionTagRef[]> {
    return (await readSessionJsonIfExists<SessionTagRef[]>(this.getTagsPath())) ?? [];
  }

  public async saveTags(tags: SessionTagRef[]): Promise<void> {
    await writeJson(
      this.getTagsPath(),
      [...tags].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  public async loadCommits(): Promise<SessionCommitRecord[]> {
    return (
      await readSessionJsonIfExists<SessionCommitRecord[]>(this.getCommitsPath())
    ) ?? [];
  }

  public async saveCommits(commits: SessionCommitRecord[]): Promise<void> {
    await writeJson(
      this.getCommitsPath(),
      [...commits].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  public async loadNode(nodeId: string): Promise<SessionNode | undefined> {
    return readSessionJsonIfExists<SessionNode>(this.getNodePath(nodeId));
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
    return readSessionJsonIfExists<SessionWorkingHead>(this.getHeadPath(headId));
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

  private getStatePath(): string {
    return path.join(this.repoRoot, "state.json");
  }

  private getBranchesPath(): string {
    return path.join(this.repoRoot, "branches.json");
  }

  private getTagsPath(): string {
    return path.join(this.repoRoot, "tags.json");
  }

  private getCommitsPath(): string {
    return path.join(this.repoRoot, "commits.json");
  }

  private getNodePath(nodeId: string): string {
    return path.join(this.nodesRoot, `${nodeId}.json`);
  }

  private getHeadPath(headId: string): string {
    return path.join(this.headsRoot, `${headId}.json`);
  }
}
