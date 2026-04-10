import matter from "gray-matter";
import {
  copyFile,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";


import type { MemoryRecord, ResolvedPaths, SkillScope } from "../types.js";
import {
  ensureDir,
  listDirectories,
  pathExists,
  readJsonIfExists,
  readTextIfExists,
  tokenize,
  writeJson,
} from "../utils/index.js";

const MEMORY_FILE_NAME = "MEMORY.md";
const MEMORY_METADATA_FILE_NAME = ".memory-meta.json";
const MEMORY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface SaveMemoryInput {
  name: string;
  description: string;
  content: string;
  scope?: SkillScope;
}

interface MemoryMetadata {
  createdAt?: string;
  updatedAt?: string;
  lastAccessedAt?: string;
}

export interface MemoryDirectories {
  projectMemoryDir: string;
  globalMemoryDir: string;
}

export interface MemoryForkWorkspace {
  rootDir: string;
  projectMemoryDir: string;
  globalMemoryDir: string;
}

export interface MemoryForkMergeResult {
  created: number;
  updated: number;
  files: string[];
}

function memoryFilePath(directoryPath: string): string {
  return path.join(directoryPath, MEMORY_FILE_NAME);
}

function memoryMetadataPath(directoryPath: string): string {
  return path.join(directoryPath, MEMORY_METADATA_FILE_NAME);
}

function isValidMemoryName(name: string): boolean {
  return MEMORY_NAME_PATTERN.test(name);
}

function buildKeywords(
  name: string,
  description: string,
  content: string,
): string[] {
  return Array.from(
    new Set([
      ...tokenize(name),
      ...tokenize(description),
      ...tokenize(content),
    ]),
  );
}

function normalizeBody(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function formatMemoryMarkdown(
  name: string,
  description: string,
  content: string,
): string {
  const body = normalizeBody(content);
  return `${matter.stringify(body, { name, description }).trimEnd()}\n`;
}

async function listMemoryDirectories(rootDir: string): Promise<string[]> {
  const directories = await listDirectories(rootDir);
  const results: string[] = [];

  for (const directoryPath of directories) {
    if (await pathExists(memoryFilePath(directoryPath))) {
      results.push(directoryPath);
    }
  }

  return results.sort((left, right) => left.localeCompare(right));
}

async function copyDirectoryRecursive(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await ensureDir(targetDir);
  const entries = await readdir(sourceDir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        await copyDirectoryRecursive(sourcePath, targetPath);
        return;
      }

      if (entry.isFile()) {
        await ensureDir(path.dirname(targetPath));
        await copyFile(sourcePath, targetPath);
      }
    }),
  );
}

async function copyMemoryDirectories(
  source: MemoryDirectories,
  target: MemoryDirectories,
): Promise<void> {
  await Promise.all([
    copyMemoryDirectoriesInScope(source.projectMemoryDir, target.projectMemoryDir),
    copyMemoryDirectoriesInScope(source.globalMemoryDir, target.globalMemoryDir),
  ]);
}

async function copyMemoryDirectoriesInScope(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await ensureDir(targetDir);
  const memoryDirectories = await listMemoryDirectories(sourceDir);
  await Promise.all(
    memoryDirectories.map(async (directoryPath) => {
      await copyDirectoryRecursive(
        directoryPath,
        path.join(targetDir, path.basename(directoryPath)),
      );
    }),
  );
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        results.push(path.relative(rootDir, absolutePath));
      }
    }
  }

  await walk(rootDir);
  return results.sort((left, right) => left.localeCompare(right));
}

async function isSourceTreeSynced(
  sourceDir: string,
  targetDir: string,
): Promise<boolean> {
  if (!(await pathExists(targetDir))) {
    return false;
  }

  const sourceFiles = await listFilesRecursive(sourceDir);
  for (const relativePath of sourceFiles) {
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(targetDir, relativePath);
    if (!(await pathExists(targetPath))) {
      return false;
    }

    const [sourceContent, targetContent] = await Promise.all([
      readTextIfExists(sourcePath),
      readTextIfExists(targetPath),
    ]);

    if (sourceContent !== undefined && targetContent !== undefined) {
      if (sourceContent !== targetContent) {
        return false;
      }
      continue;
    }

    const [sourceStats, targetStats] = await Promise.all([
      stat(sourcePath),
      stat(targetPath),
    ]);
    if (sourceStats.size !== targetStats.size) {
      return false;
    }
  }

  return true;
}

function validateMemoryFrontmatter(
  directoryPath: string,
  data: unknown,
): { name: string; description: string } | undefined {
  const parsed = data as {
    name?: string;
    description?: string;
  };
  const directoryName = path.basename(directoryPath);
  const name = parsed.name?.trim();
  const description = parsed.description?.trim();
  const validName =
    typeof name === "string" &&
    isValidMemoryName(name) &&
    name === directoryName;
  const validDescription =
    typeof description === "string" && description.length > 0;

  if (!validName || !validDescription) {
    return undefined;
  }

  return {
    name,
    description,
  };
}

async function loadMemoryRecord(
  directoryPath: string,
  scope: SkillScope,
): Promise<MemoryRecord | undefined> {
  const filePath = memoryFilePath(directoryPath);
  const rawContent = await readTextIfExists(filePath);
  if (!rawContent) {
    return undefined;
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(rawContent);
  } catch {
    return undefined;
  }
  const frontmatter = validateMemoryFrontmatter(directoryPath, parsed.data);
  if (!frontmatter) {
    return undefined;
  }

  const [metadata, fileStats] = await Promise.all([
    readMemoryMetadata(directoryPath),
    stat(filePath).catch(() => undefined),
  ]);
  const fallbackTimestamp =
    fileStats?.mtime.toISOString() ?? new Date().toISOString();
  const content = normalizeBody(parsed.content);

  return {
    id: frontmatter.name,
    name: frontmatter.name,
    description: frontmatter.description,
    content,
    keywords: buildKeywords(frontmatter.name, frontmatter.description, content),
    scope,
    createdAt: metadata?.createdAt ?? fallbackTimestamp,
    updatedAt: metadata?.updatedAt ?? fallbackTimestamp,
    lastAccessedAt: metadata?.lastAccessedAt,
    directoryPath,
    path: filePath,
  };
}

async function readMemoryMetadata(
  directoryPath: string,
): Promise<MemoryMetadata | undefined> {
  try {
    return await readJsonIfExists<MemoryMetadata>(
      memoryMetadataPath(directoryPath),
    );
  } catch {
    return undefined;
  }
}

async function writeMemoryRecord(
  directoryPath: string,
  record: Pick<MemoryRecord, "name" | "description" | "content">,
  metadata: MemoryMetadata,
): Promise<void> {
  await ensureDir(directoryPath);
  await writeFile(
    memoryFilePath(directoryPath),
    formatMemoryMarkdown(record.name, record.description, record.content),
    "utf8",
  );
  await writeJson(memoryMetadataPath(directoryPath), metadata);
}

async function mergeForkDirectory(
  sourceDir: string,
  targetDir: string,
  scope: SkillScope,
): Promise<MemoryForkMergeResult> {
  await ensureDir(targetDir);
  const sourceMemoryDirectories = await listMemoryDirectories(sourceDir);
  let created = 0;
  let updated = 0;
  const files: string[] = [];

  for (const sourceDirectoryPath of sourceMemoryDirectories) {
    const sourceRecord = await loadMemoryRecord(sourceDirectoryPath, scope);
    if (!sourceRecord) {
      continue;
    }

    const targetDirectoryPath = path.join(targetDir, sourceRecord.name);
    const targetRecord = await loadMemoryRecord(targetDirectoryPath, scope);
    const synced = await isSourceTreeSynced(sourceDirectoryPath, targetDirectoryPath);
    if (!targetRecord) {
      created += 1;
    } else if (!synced) {
      updated += 1;
    } else {
      continue;
    }

    await copyDirectoryRecursive(sourceDirectoryPath, targetDirectoryPath);
    await writeMemoryRecord(
      targetDirectoryPath,
      sourceRecord,
      {
        createdAt: targetRecord?.createdAt ?? sourceRecord.createdAt,
        updatedAt: sourceRecord.updatedAt,
        lastAccessedAt: sourceRecord.lastAccessedAt ?? targetRecord?.lastAccessedAt,
      },
    );
    files.push(memoryFilePath(targetDirectoryPath));
  }

  return {
    created,
    updated,
    files,
  };
}

async function mergeMemoryDirectories(
  source: MemoryDirectories,
  target: MemoryDirectories,
): Promise<MemoryForkMergeResult> {
  const [projectResult, globalResult] = await Promise.all([
    mergeForkDirectory(source.projectMemoryDir, target.projectMemoryDir, "project"),
    mergeForkDirectory(source.globalMemoryDir, target.globalMemoryDir, "global"),
  ]);

  return {
    created: projectResult.created + globalResult.created,
    updated: projectResult.updated + globalResult.updated,
    files: [...projectResult.files, ...globalResult.files],
  };
}

function scoreRecord(record: MemoryRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  let score = 0;
  for (const token of queryTokens) {
    if (record.name.toLowerCase().includes(token)) {
      score += 5;
    }
    if (record.description.toLowerCase().includes(token)) {
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
  public constructor(
    private readonly paths: Pick<
      ResolvedPaths,
      "projectMemoryDir" | "globalMemoryDir"
    >,
  ) {}

  public getDirectories(): MemoryDirectories {
    return {
      projectMemoryDir: this.paths.projectMemoryDir,
      globalMemoryDir: this.paths.globalMemoryDir,
    };
  }

  public async save(input: SaveMemoryInput): Promise<MemoryRecord> {
    const scope = input.scope ?? "project";
    const name = input.name.trim();
    const description = input.description.trim();
    const content = normalizeBody(input.content);

    if (!isValidMemoryName(name)) {
      throw new Error(
        "memory name 必须是 kebab-case，且只能包含小写字母、数字与连字符。",
      );
    }
    if (!description) {
      throw new Error("memory description 不能为空。");
    }
    if (!content) {
      throw new Error("memory content 不能为空。");
    }

    const rootDirectory =
      scope === "global" ? this.paths.globalMemoryDir : this.paths.projectMemoryDir;
    const directoryPath = path.join(rootDirectory, name);
    const existing = await loadMemoryRecord(directoryPath, scope);
    const now = new Date().toISOString();

    await writeMemoryRecord(
      directoryPath,
      {
        name,
        description,
        content,
      },
      {
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastAccessedAt: existing?.lastAccessedAt,
      },
    );

    const saved = await loadMemoryRecord(directoryPath, scope);
    if (!saved) {
      throw new Error(`保存 memory 失败：${name}`);
    }
    return saved;
  }

  public async list(limit = 20): Promise<MemoryRecord[]> {
    const records = await this.loadAll();
    return records
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  public async show(id: string): Promise<MemoryRecord | undefined> {
    const records = await this.loadAll();
    const normalized = id.trim().toLowerCase();
    return records.find((record) => record.id.toLowerCase() === normalized);
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

  public async createForkWorkspace(input?: {
    rootDir?: string;
    sourceDirectories?: MemoryDirectories;
  }): Promise<MemoryForkWorkspace> {
    const rootDir =
      input?.rootDir
        ?? (await mkdtemp(path.join(os.tmpdir(), "qagent-memory-fork-")));
    const projectMemoryDir = path.join(rootDir, "project-memory");
    const globalMemoryDir = path.join(rootDir, "global-memory");
    await copyMemoryDirectories(
      input?.sourceDirectories ?? this.getDirectories(),
      {
        projectMemoryDir,
        globalMemoryDir,
      },
    );

    return {
      rootDir,
      projectMemoryDir,
      globalMemoryDir,
    };
  }

  public async mergeForkWorkspace(
    workspace: MemoryForkWorkspace,
    targetDirectories?: MemoryDirectories,
  ): Promise<MemoryForkMergeResult> {
    return mergeMemoryDirectories(
      {
        projectMemoryDir: workspace.projectMemoryDir,
        globalMemoryDir: workspace.globalMemoryDir,
      },
      targetDirectories ?? this.getDirectories(),
    );
  }

  public async disposeForkWorkspace(workspace: MemoryForkWorkspace): Promise<void> {
    await rm(workspace.rootDir, { recursive: true, force: true });
  }

  private async loadAll(): Promise<MemoryRecord[]> {
    const [globalDirectories, projectDirectories] = await Promise.all([
      listMemoryDirectories(this.paths.globalMemoryDir),
      listMemoryDirectories(this.paths.projectMemoryDir),
    ]);
    const records = await Promise.all([
      ...projectDirectories.map((directoryPath) =>
        loadMemoryRecord(directoryPath, "project"),
      ),
      ...globalDirectories.map((directoryPath) =>
        loadMemoryRecord(directoryPath, "global"),
      ),
    ]);

    return records.filter((record): record is MemoryRecord => Boolean(record));
  }
}
