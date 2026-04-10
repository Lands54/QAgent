import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

export async function readTextIfExists(
  targetPath: string,
): Promise<string | undefined> {
  try {
    return await readFile(targetPath, "utf8");
  } catch {
    return undefined;
  }
}

export async function readJsonIfExists<T>(
  targetPath: string,
): Promise<T | undefined> {
  const content = await readTextIfExists(targetPath);
  if (!content) {
    return undefined;
  }

  return JSON.parse(content) as T;
}

export async function writeJson(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await writeTextAtomic(targetPath, JSON.stringify(value, null, 2));
}

export async function writeTextAtomic(
  targetPath: string,
  value: string,
): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, value, "utf8");
  await rename(tempPath, targetPath);
}

export async function appendNdjson(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await writeFile(targetPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

export async function listDirectories(rootPath: string): Promise<string[]> {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}
