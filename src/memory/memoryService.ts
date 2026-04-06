import path from "node:path";
import { readdir } from "node:fs/promises";

import type { MemoryRecord, ResolvedPaths, SkillScope } from "../types.js";
import {
  createId,
  ensureDir,
  firstLine,
  readJsonIfExists,
  tokenize,
  writeJson,
} from "../utils/index.js";

interface SaveMemoryInput {
  content: string;
  title?: string;
  tags?: string[];
  scope?: SkillScope;
}

function buildKeywords(title: string, content: string, tags: string[]): string[] {
  return Array.from(new Set([...tokenize(title), ...tokenize(content), ...tags]));
}

async function listMemoryFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(rootDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function scoreRecord(record: MemoryRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  let score = 0;
  for (const token of queryTokens) {
    if (record.title.toLowerCase().includes(token)) {
      score += 5;
    }
    if (record.tags.some((tag) => tag.toLowerCase().includes(token))) {
      score += 4;
    }
    if (record.keywords.some((keyword) => keyword.includes(token))) {
      score += 3;
    }
    if (record.content.toLowerCase().includes(token)) {
      score += 1;
    }
  }

  const ageHours =
    (Date.now() - new Date(record.updatedAt).getTime()) / (1000 * 60 * 60);
  return score + Math.max(0, 24 - ageHours) / 24;
}

export class MemoryService {
  public constructor(private readonly paths: ResolvedPaths) {}

  public async save(input: SaveMemoryInput): Promise<MemoryRecord> {
    const scope = input.scope ?? "project";
    const directory =
      scope === "global" ? this.paths.globalMemoryDir : this.paths.projectMemoryDir;
    await ensureDir(directory);

    const id = createId("memory");
    const now = new Date().toISOString();
    const title = input.title?.trim() || firstLine(input.content, "新记忆");
    const tags = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
    const record: MemoryRecord = {
      id,
      title,
      content: input.content.trim(),
      tags,
      keywords: buildKeywords(title, input.content, tags),
      scope,
      createdAt: now,
      updatedAt: now,
      path: path.join(directory, `${id}.json`),
    };

    await writeJson(record.path, record);
    return record;
  }

  public async list(limit = 20): Promise<MemoryRecord[]> {
    const records = await this.loadAll();
    return records
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  public async show(id: string): Promise<MemoryRecord | undefined> {
    const records = await this.loadAll();
    return records.find((record) => record.id === id);
  }

  public async search(query: string, limit = 5): Promise<MemoryRecord[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const records = await this.loadAll();
    return records
      .map((record) => ({ record, score: scoreRecord(record, queryTokens) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => item.record);
  }

  private async loadAll(): Promise<MemoryRecord[]> {
    const [globalFiles, projectFiles] = await Promise.all([
      listMemoryFiles(this.paths.globalMemoryDir),
      listMemoryFiles(this.paths.projectMemoryDir),
    ]);
    const files = [...projectFiles, ...globalFiles];

    const records = await Promise.all(
      files.map(async (filePath) => {
        return readJsonIfExists<MemoryRecord>(filePath);
      }),
    );

    return records.filter((record): record is MemoryRecord => Boolean(record));
  }
}
