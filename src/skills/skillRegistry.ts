import matter from "gray-matter";
import path from "node:path";

import type { ResolvedPaths, SkillManifest, SkillScope } from "../types.js";
import { listDirectories, pathExists, readTextIfExists } from "../utils/index.js";

async function readSkillFile(directoryPath: string): Promise<string | undefined> {
  const candidates = ["SKILL.md", "skill.md"];
  for (const candidate of candidates) {
    const filePath = path.join(directoryPath, candidate);
    if (await pathExists(filePath)) {
      return filePath;
    }
  }

  return undefined;
}

async function discoverSkillsInScope(
  rootPath: string,
  scope: SkillScope,
): Promise<SkillManifest[]> {
  const directories = await listDirectories(rootPath);
  const results: SkillManifest[] = [];

  for (const directoryPath of directories) {
    const filePath = await readSkillFile(directoryPath);
    if (!filePath) {
      continue;
    }

    const content = await readTextIfExists(filePath);
    if (!content) {
      continue;
    }

    let parsed: ReturnType<typeof matter>;
    try {
      parsed = matter(content);
    } catch {
      continue;
    }

    const directoryName = path.basename(directoryPath);
    const data = parsed.data as {
      name?: unknown;
      description?: unknown;
    };
    const name = typeof data.name === "string" ? data.name.trim() : undefined;
    const description =
      typeof data.description === "string"
        ? data.description.trim()
        : undefined;
    const validName =
      typeof name === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) &&
      name === directoryName;
    const validDescription =
      typeof description === "string" && description.length > 0;

    if (!validName || !validDescription) {
      continue;
    }

    results.push({
      id: `${scope}:${directoryName}`,
      name,
      description,
      scope,
      directoryPath,
      filePath,
      content: parsed.content.trim(),
    });
  }

  return results.sort((left, right) => left.name.localeCompare(right.name));
}

export class SkillRegistry {
  private cache: SkillManifest[] = [];

  public constructor(private readonly paths: ResolvedPaths) {}

  public async refresh(): Promise<SkillManifest[]> {
    const [globalSkills, projectSkills] = await Promise.all([
      discoverSkillsInScope(this.paths.globalSkillsDir, "global"),
      discoverSkillsInScope(this.paths.projectSkillsDir, "project"),
    ]);

    this.cache = [...projectSkills, ...globalSkills];
    return this.cache;
  }

  public getAll(): SkillManifest[] {
    return [...this.cache];
  }

  public find(identifier: string): SkillManifest | undefined {
    const normalized = identifier.trim().toLowerCase();
    return this.cache.find((skill) => {
      return (
        skill.id.toLowerCase() === normalized ||
        skill.name.toLowerCase() === normalized ||
        path.basename(skill.directoryPath).toLowerCase() === normalized
      );
    });
  }
}
