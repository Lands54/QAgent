import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SkillRegistry } from "../../src/skills/skillRegistry.js";
import type { ResolvedPaths } from "../../src/types.js";
import {
  INVALID_MOCK_SKILL_NAMES,
  VALID_MOCK_SKILL_NAMES,
  buildMockSkillResolvedPaths,
} from "../helpers/mockSkillFixture.js";

function buildTempResolvedPaths(rootPath: string): ResolvedPaths {
  const homeDir = path.join(rootPath, "home");
  const projectRoot = path.join(rootPath, "project");

  return {
    cwd: projectRoot,
    homeDir,
    globalAgentDir: path.join(homeDir, ".agent"),
    projectRoot,
    projectAgentDir: path.join(projectRoot, ".agent"),
    globalConfigPath: path.join(homeDir, ".agent", "config.json"),
    projectConfigPath: path.join(projectRoot, ".agent", "config.json"),
    globalMemoryDir: path.join(homeDir, ".agent", "memory"),
    projectMemoryDir: path.join(projectRoot, ".agent", "memory"),
    globalSkillsDir: path.join(homeDir, ".agent", "skills"),
    projectSkillsDir: path.join(projectRoot, ".agent", "skills"),
    sessionRoot: path.join(projectRoot, ".agent", "sessions"),
  };
}

describe("SkillRegistry", () => {
  it("能从 mock fixture 中发现 5 个有效 Skill，并保留目录与正文信息", async () => {
    const registry = new SkillRegistry(buildMockSkillResolvedPaths());
    const skills = await registry.refresh();

    expect(skills).toHaveLength(VALID_MOCK_SKILL_NAMES.length);
    expect(skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining([...VALID_MOCK_SKILL_NAMES]),
    );
    expect(registry.find("pdf-processing")).toMatchObject({
      scope: "project",
      name: "pdf-processing",
    });
    expect(registry.find("global:api-testing")).toMatchObject({
      scope: "global",
      name: "api-testing",
    });
    expect(registry.find("repo-maintenance")?.directoryPath).toContain(
      "/project/.agent/skills/repo-maintenance",
    );
    expect(registry.find("incident-triage")?.content).toContain(
      "GLOBAL BODY MARKER: incident-triage",
    );
  });

  it("会过滤掉名称非法或目录名不匹配的 Skill", async () => {
    const registry = new SkillRegistry(buildMockSkillResolvedPaths());
    await registry.refresh();

    for (const invalidName of INVALID_MOCK_SKILL_NAMES) {
      expect(registry.find(invalidName)).toBeUndefined();
    }
    expect(registry.find("different-name")).toBeUndefined();
  });

  it("会跳过 frontmatter 损坏的 Skill，而不是打断整个刷新", async () => {
    const paths = buildTempResolvedPaths(
      await mkdtemp(path.join(os.tmpdir(), "qagent-skills-")),
    );
    const validSkillDir = path.join(paths.projectSkillsDir, "good-skill");
    const brokenSkillDir = path.join(paths.projectSkillsDir, "broken-skill");

    await mkdir(validSkillDir, { recursive: true });
    await mkdir(brokenSkillDir, { recursive: true });
    await writeFile(
      path.join(validSkillDir, "SKILL.md"),
      [
        "---",
        "name: good-skill",
        "description: Good skill",
        "---",
        "VALID BODY",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(brokenSkillDir, "SKILL.md"),
      ["---", "name: [", "---", "BROKEN BODY"].join("\n"),
      "utf8",
    );

    const registry = new SkillRegistry(paths);
    const skills = await registry.refresh();

    expect(skills.map((skill) => skill.name)).toEqual(["good-skill"]);
    expect(registry.find("broken-skill")).toBeUndefined();
  });
});
