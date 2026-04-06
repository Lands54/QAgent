import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/context/promptAssembler.js";
import { SkillRegistry } from "../../src/skills/skillRegistry.js";
import type { RuntimeConfig, SkillManifest } from "../../src/types.js";
import {
  VALID_MOCK_SKILL_NAMES,
  buildMockSkillResolvedPaths,
  buildMockSkillRuntimeConfig,
} from "../helpers/mockSkillFixture.js";

describe("PromptAssembler", () => {
  it("会把全部 skill 的 name/description 合成一段 YAML 注入上下文", () => {
    const config: RuntimeConfig = {
      cwd: "/tmp/project",
      resolvedPaths: {
        cwd: "/tmp/project",
        homeDir: "/tmp/home",
        globalAgentDir: "/tmp/home/.agent",
        projectRoot: "/tmp/project",
        projectAgentDir: "/tmp/project/.agent",
        globalConfigPath: "/tmp/home/.agent/config.json",
        projectConfigPath: "/tmp/project/.agent/config.json",
        globalMemoryDir: "/tmp/home/.agent/memory",
        projectMemoryDir: "/tmp/project/.agent/memory",
        globalSkillsDir: "/tmp/home/.agent/skills",
        projectSkillsDir: "/tmp/project/.agent/skills",
        sessionRoot: "/tmp/project/.agent/sessions",
      },
      model: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        temperature: 0.2,
      },
      runtime: {
        maxAgentSteps: 8,
        shellCommandTimeoutMs: 120_000,
        maxToolOutputChars: 12_000,
        maxConversationSummaryMessages: 10,
      },
      tool: {
        approvalMode: "always",
        shellExecutable: "/bin/zsh",
      },
      cli: {},
    };

    const skills: SkillManifest[] = [
      {
        id: "project:pdf-processing",
        name: "pdf-processing",
        description: "Use when working with PDF files.",
        scope: "project",
        directoryPath: "/tmp/project/.agent/skills/pdf-processing",
        filePath: "/tmp/project/.agent/skills/pdf-processing/SKILL.md",
        content: "# body",
      },
      {
        id: "global:data-analysis",
        name: "data-analysis",
        description: "Use when analyzing structured datasets.",
        scope: "global",
        directoryPath: "/tmp/home/.agent/skills/data-analysis",
        filePath: "/tmp/home/.agent/skills/data-analysis/SKILL.md",
        content: "# body",
      },
    ];

    const assembled = new PromptAssembler().assemble({
      config,
      agentLayers: [],
      availableSkills: skills,
      relevantMemories: [],
      modelMessages: [],
      shellCwd: "/tmp/project",
    });

    expect(assembled.systemPrompt).toContain("skills:");
    expect(assembled.systemPrompt).toContain('name: "pdf-processing"');
    expect(assembled.systemPrompt).toContain(
      'description: "Use when working with PDF files."',
    );
    expect(assembled.systemPrompt).toContain(
      "不会自动注入每个 Skill 的正文内容",
    );
  });

  it("使用 mock skill fixture 时，只注入 5 个 skill 的 YAML 元信息，不注入正文标记", async () => {
    const config = buildMockSkillRuntimeConfig();
    const registry = new SkillRegistry(buildMockSkillResolvedPaths());
    const skills = await registry.refresh();

    const assembled = new PromptAssembler().assemble({
      config,
      agentLayers: [],
      availableSkills: skills,
      relevantMemories: [],
      modelMessages: [],
      shellCwd: config.cwd,
    });

    expect(
      assembled.layers.some((layer) => layer.source === "skill-catalog"),
    ).toBe(true);
    expect(assembled.systemPrompt).toContain(`项目技能根目录：${config.resolvedPaths.projectSkillsDir}`);
    expect(assembled.systemPrompt).toContain(`全局技能根目录：${config.resolvedPaths.globalSkillsDir}`);

    for (const skillName of VALID_MOCK_SKILL_NAMES) {
      expect(assembled.systemPrompt).toContain(`name: "${skillName}"`);
    }

    expect(assembled.systemPrompt).not.toContain(
      "PROJECT BODY MARKER: pdf-processing",
    );
    expect(assembled.systemPrompt).not.toContain(
      "GLOBAL BODY MARKER: api-testing",
    );
  });
});
