import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/context/promptAssembler.js";
import { SkillRegistry } from "../../src/skills/skillRegistry.js";
import type { MemoryRecord, RuntimeConfig, SkillManifest } from "../../src/types.js";
import { getDefaultTestShellExecutable } from "../helpers/hostShellFixture.js";
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
        fetchMemoryMaxAgentSteps: 3,
        autoMemoryForkMaxAgentSteps: 4,
        shellCommandTimeoutMs: 120_000,
        maxToolOutputChars: 12_000,
        maxConversationSummaryMessages: 10,
        autoCompactThresholdTokens: 120_000,
        compactRecentKeepGroups: 8,
      },
      tool: {
        approvalMode: "always",
        shellExecutable: getDefaultTestShellExecutable(),
      },
      cli: {},
    };

    const skills: SkillManifest[] = [
      {
        id: "project:pdf-processing",
        name: "pdf-processing",
        description: "适用于处理 PDF 文件。",
        scope: "project",
        directoryPath: "/tmp/project/.agent/skills/pdf-processing",
        filePath: "/tmp/project/.agent/skills/pdf-processing/SKILL.md",
        content: "# 正文",
      },
      {
        id: "global:data-analysis",
        name: "data-analysis",
        description: "适用于分析结构化数据集。",
        scope: "global",
        directoryPath: "/tmp/home/.agent/skills/data-analysis",
        filePath: "/tmp/home/.agent/skills/data-analysis/SKILL.md",
        content: "# 正文",
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
      'description: "适用于处理 PDF 文件。"',
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
      "项目正文标记：pdf-processing",
    );
    expect(assembled.systemPrompt).not.toContain(
      "全局正文标记：api-testing",
    );
  });

  it("default profile 会保留 skill catalog，但不注入 memory recent 或动态时间", () => {
    const config = buildMockSkillRuntimeConfig();
    const memories: MemoryRecord[] = [
      {
        id: "reply-language",
        name: "reply-language",
        description: "偏好使用中文回复",
        content: "完整正文",
        keywords: ["reply-language", "中文"],
        scope: "project",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        directoryPath: "/tmp/project/.agent/memory/reply-language",
        path: "/tmp/project/.agent/memory/reply-language/MEMORY.md",
      },
    ];

    const assembled = new PromptAssembler().assemble({
      config,
      profile: "default",
      agentLayers: [],
      availableSkills: [
        {
          id: "project:pdf-processing",
          name: "pdf-processing",
          description: "处理 PDF",
          scope: "project",
          directoryPath: "/tmp/project/.agent/skills/pdf-processing",
          filePath: "/tmp/project/.agent/skills/pdf-processing/SKILL.md",
          content: "# 正文",
        },
      ],
      relevantMemories: memories,
      modelMessages: [
        {
          id: "user-1",
          role: "user",
          content: "上一轮消息",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      shellCwd: config.cwd,
    });

    expect(assembled.systemPrompt).toContain("skills:");
    expect(assembled.systemPrompt).toContain('name: "pdf-processing"');
    expect(assembled.systemPrompt).not.toContain("记忆：reply-language");
    expect(assembled.systemPrompt).not.toContain("最近会话摘要");
    expect(assembled.systemPrompt).not.toContain("当前时间：");
    expect(assembled.systemPrompt).not.toContain("当前 shell 工作目录：");
    expect(assembled.systemPrompt).not.toContain("当前工具审批模式：");
    expect(assembled.systemPrompt).not.toContain("当前最大自治步数：");
  });

  it("auto-memory profile 只保留静态 system prompt 层，不注入 skill memory recent 和动态时间", () => {
    const config = buildMockSkillRuntimeConfig({
      model: {
        systemPrompt: "你是自动记忆整理代理。",
      },
    });
    const assembled = new PromptAssembler().assemble({
      config,
      profile: "auto-memory",
      agentLayers: [],
      availableSkills: [
        {
          id: "project:pdf-processing",
          name: "pdf-processing",
          description: "处理 PDF",
          scope: "project",
          directoryPath: "/tmp/project/.agent/skills/pdf-processing",
          filePath: "/tmp/project/.agent/skills/pdf-processing/SKILL.md",
          content: "# 正文",
        },
      ],
      relevantMemories: [
        {
          id: "reply-language",
          name: "reply-language",
          description: "偏好使用中文回复",
          content: "完整正文",
          keywords: ["reply-language"],
          scope: "project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          directoryPath: "/tmp/project/.agent/memory/reply-language",
          path: "/tmp/project/.agent/memory/reply-language/MEMORY.md",
        },
      ],
      modelMessages: [
        {
          id: "user-1",
          role: "user",
          content: "上一轮对话",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      shellCwd: config.cwd,
    });

    expect(assembled.systemPrompt).toContain("你是自动记忆整理代理。");
    expect(assembled.systemPrompt).not.toContain("skills:");
    expect(assembled.systemPrompt).not.toContain("记忆：reply-language");
    expect(assembled.systemPrompt).not.toContain("最近会话摘要");
    expect(assembled.systemPrompt).not.toContain("当前时间：");
    expect(assembled.systemPrompt).not.toContain(config.cwd);
  });

  it("compact-session 在无工具模式下不会注入 skill，且基础规则不会再声称可用 shell", () => {
    const config = buildMockSkillRuntimeConfig({
      model: {
        systemPrompt: "你正在执行 compact-session 子任务。",
      },
    });
    const assembled = new PromptAssembler().assemble({
      config,
      profile: "compact-session",
      toolMode: "none",
      agentLayers: [],
      availableSkills: [
        {
          id: "project:pdf-processing",
          name: "pdf-processing",
          description: "处理 PDF",
          scope: "project",
          directoryPath: "/tmp/project/.agent/skills/pdf-processing",
          filePath: "/tmp/project/.agent/skills/pdf-processing/SKILL.md",
          content: "# 正文",
        },
      ],
      relevantMemories: [],
      modelMessages: [],
      shellCwd: config.cwd,
    });

    expect(assembled.systemPrompt).toContain("你正在执行 compact-session 子任务。");
    expect(assembled.systemPrompt).toContain("当前回合不暴露任何工具。");
    expect(assembled.systemPrompt).not.toContain("你只能使用一个名为 shell 的工具。");
    expect(assembled.systemPrompt).not.toContain("skills:");
  });
});
