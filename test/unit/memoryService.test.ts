import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MemoryService } from "../../src/memory/memoryService.js";
import type { ResolvedPaths } from "../../src/types.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("MemoryService", () => {
  it("能保存并检索项目级与全局记忆", async () => {
    const homeDir = await makeTempDir("qagent-home-");
    const projectDir = await makeTempDir("qagent-project-");
    const paths: ResolvedPaths = {
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

    const service = new MemoryService(paths);
    const recordA = await service.save({
      content: "项目偏好：shell 工具默认全部确认。",
      tags: ["policy"],
    });
    const recordB = await service.save({
      content: "全局偏好：回复使用中文。",
      scope: "global",
      tags: ["language"],
    });

    const list = await service.list();
    const search = await service.search("中文", 5);

    expect(list.map((item) => item.id)).toContain(recordA.id);
    expect(list.map((item) => item.id)).toContain(recordB.id);
    expect(search[0]?.content).toContain("中文");
  });
});
