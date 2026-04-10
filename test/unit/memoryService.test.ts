import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MemoryService } from "../../src/memory/memoryService.js";
import type { ResolvedPaths } from "../../src/types.js";
import { readJsonIfExists, readTextIfExists } from "../../src/utils/index.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMemoryDirectory(input: {
  rootDir: string;
  name: string;
  description?: string;
  content: string;
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    lastAccessedAt?: string;
  };
  extraFiles?: Array<{ relativePath: string; content: string }>;
}): Promise<void> {
  const directoryPath = path.join(input.rootDir, input.name);
  await mkdir(directoryPath, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${input.name}`,
    ...(input.description ? [`description: ${input.description}`] : []),
    "---",
    "",
    input.content,
    "",
  ].join("\n");
  await writeFile(path.join(directoryPath, "MEMORY.md"), frontmatter, "utf8");

  if (input.metadata) {
    await writeFile(
      path.join(directoryPath, ".memory-meta.json"),
      JSON.stringify(input.metadata, null, 2),
      "utf8",
    );
  }

  for (const file of input.extraFiles ?? []) {
    const targetPath = path.join(directoryPath, file.relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf8");
  }
}

describe("MemoryService", () => {
  function buildResolvedPaths(homeDir: string, projectDir: string): ResolvedPaths {
    return {
      cwd: projectDir,
      homeDir,
      globalAgentDir: path.join(homeDir, ".agent"),
      projectRoot: projectDir,
      projectAgentDir: path.join(projectDir, ".agent"),
      globalConfigPath: path.join(homeDir, ".agent", "config.json"),
      projectConfigPath: path.join(projectDir, ".agent", "config.json"),
      globalMemoryDir: path.join(homeDir, ".agent", "memory"),
      projectMemoryDir: path.join(projectDir, ".agent", "memory"),
      globalSkillsDir: path.join(homeDir, ".agent", "skills"),
      projectSkillsDir: path.join(projectDir, ".agent", "skills"),
      sessionRoot: path.join(projectDir, ".agent", "sessions"),
    };
  }

  it("能按目录格式保存并检索项目级与全局记忆", async () => {
    const homeDir = await makeTempDir("qagent-home-");
    const projectDir = await makeTempDir("qagent-project-");
    const paths = buildResolvedPaths(homeDir, projectDir);

    const service = new MemoryService(paths);
    const recordA = await service.save({
      name: "shell-policy",
      description: "项目内 shell 审批策略",
      content: "项目偏好：shell 工具默认全部确认。",
    });
    const recordB = await service.save({
      name: "reply-language",
      description: "全局回复语言偏好",
      content: "全局偏好：回复使用中文。",
      scope: "global",
    });

    const list = await service.list();
    const search = await service.search("中文 回复", 5);
    const markdown = await readTextIfExists(
      path.join(paths.projectMemoryDir, "shell-policy", "MEMORY.md"),
    );
    const metadata = await readJsonIfExists<{
      createdAt?: string;
      updatedAt?: string;
    }>(
      path.join(paths.projectMemoryDir, "shell-policy", ".memory-meta.json"),
    );

    expect(recordA.id).toBe("shell-policy");
    expect(recordA.name).toBe("shell-policy");
    expect(recordA.path).toBe(
      path.join(paths.projectMemoryDir, "shell-policy", "MEMORY.md"),
    );
    expect(recordB.scope).toBe("global");
    expect(list.map((item) => item.id)).toEqual(
      expect.arrayContaining(["shell-policy", "reply-language"]),
    );
    expect(search[0]?.name).toBe("reply-language");
    expect(markdown).toContain("name: shell-policy");
    expect(markdown).toContain("description: 项目内 shell 审批策略");
    expect(metadata?.createdAt).toBeTruthy();
    expect(metadata?.updatedAt).toBeTruthy();
  });

  it("会忽略 frontmatter 非法的 memory 目录", async () => {
    const homeDir = await makeTempDir("qagent-home-");
    const projectDir = await makeTempDir("qagent-project-");
    const paths = buildResolvedPaths(homeDir, projectDir);
    const service = new MemoryService(paths);

    await writeMemoryDirectory({
      rootDir: paths.projectMemoryDir,
      name: "valid-memory",
      description: "合法的记忆",
      content: "这是有效内容。",
    });
    await writeFile(
      path.join(paths.projectMemoryDir, "valid-memory", ".memory-meta.json"),
      "{",
      "utf8",
    );
    await writeMemoryDirectory({
      rootDir: paths.projectMemoryDir,
      name: "missing-description",
      content: "缺少 description。",
    });
    await writeMemoryDirectory({
      rootDir: paths.projectMemoryDir,
      name: "mismatch-name",
      description: "名称不匹配",
      content: "这条也应被忽略。",
    });
    await writeFile(
      path.join(paths.projectMemoryDir, "mismatch-name", "MEMORY.md"),
      [
        "---",
        "name: another-name",
        "description: 名称与目录不一致",
        "---",
        "",
        "无效 memory",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeMemoryDirectory({
      rootDir: paths.projectMemoryDir,
      name: "bad-Uppercase",
      description: "非法目录名",
      content: "也应被忽略。",
    });
    await writeFile(
      path.join(paths.projectMemoryDir, "bad-Uppercase", "MEMORY.md"),
      [
        "---",
        "name: bad-Uppercase",
        "description: 非法 name",
        "---",
        "",
        "无效 memory",
        "",
      ].join("\n"),
      "utf8",
    );
    const malformedDir = path.join(paths.projectMemoryDir, "malformed-memory");
    await mkdir(malformedDir, { recursive: true });
    await writeFile(
      path.join(malformedDir, "MEMORY.md"),
      ["---", "name: [", "---", "坏 frontmatter 不应打断列表"].join("\n"),
      "utf8",
    );

    const list = await service.list();

    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("valid-memory");
  });

  it("能把 fork 工作区里的 memory 目录与资产 merge 回正式目录", async () => {
    const homeDir = await makeTempDir("qagent-home-");
    const projectDir = await makeTempDir("qagent-project-");
    const paths = buildResolvedPaths(homeDir, projectDir);
    const service = new MemoryService(paths);

    const original = await service.save({
      name: "legacy-memory",
      description: "旧记忆",
      content: "旧内容",
    });
    await writeFile(
      path.join(paths.projectMemoryDir, "legacy-memory", "keep.txt"),
      "target-only asset",
      "utf8",
    );

    const workspace = await service.createForkWorkspace();
    await writeMemoryDirectory({
      rootDir: workspace.projectMemoryDir,
      name: "legacy-memory",
      description: "更新后的旧记忆",
      content: "更新后的内容",
      metadata: {
        createdAt: original.createdAt,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    await writeMemoryDirectory({
      rootDir: workspace.projectMemoryDir,
      name: "fresh-note",
      description: "新的长期偏好",
      content: "新的长期偏好正文",
      extraFiles: [
        {
          relativePath: "assets/context.txt",
          content: "附属资产也要被 merge",
        },
      ],
    });

    const result = await service.mergeForkWorkspace(workspace);
    await service.disposeForkWorkspace(workspace);

    const updated = await service.show("legacy-memory");
    const created = await service.show("fresh-note");
    const createdMetadata = await readJsonIfExists<{
      createdAt?: string;
      updatedAt?: string;
    }>(
      path.join(paths.projectMemoryDir, "fresh-note", ".memory-meta.json"),
    );
    const mergedAsset = await readTextIfExists(
      path.join(paths.projectMemoryDir, "fresh-note", "assets", "context.txt"),
    );
    const preservedTargetOnlyAsset = await readTextIfExists(
      path.join(paths.projectMemoryDir, "legacy-memory", "keep.txt"),
    );

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(updated?.description).toBe("更新后的旧记忆");
    expect(updated?.content).toBe("更新后的内容");
    expect(created?.id).toBe("fresh-note");
    expect(created?.scope).toBe("project");
    expect(created?.path).toBe(
      path.join(paths.projectMemoryDir, "fresh-note", "MEMORY.md"),
    );
    expect(createdMetadata?.updatedAt).toBeTruthy();
    expect(mergedAsset).toBe("附属资产也要被 merge");
    expect(preservedTargetOnlyAsset).toBe("target-only asset");
  });
});
