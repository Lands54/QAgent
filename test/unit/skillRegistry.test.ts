import { describe, expect, it } from "vitest";

import { SkillRegistry } from "../../src/skills/skillRegistry.js";
import {
  INVALID_MOCK_SKILL_NAMES,
  VALID_MOCK_SKILL_NAMES,
  buildMockSkillResolvedPaths,
} from "../helpers/mockSkillFixture.js";

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
});
