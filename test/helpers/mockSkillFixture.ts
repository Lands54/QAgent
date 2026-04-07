import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedPaths, RuntimeConfig } from "../../src/types.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDir, "../fixtures/mock-skills");

export const VALID_MOCK_SKILL_NAMES = [
  "pdf-processing",
  "repo-maintenance",
  "ui-regression",
  "api-testing",
  "incident-triage",
] as const;

export const INVALID_MOCK_SKILL_NAMES = [
  "bad-Uppercase",
  "mismatch-name",
] as const;

export function getMockSkillFixtureRoot(): string {
  return fixtureRoot;
}

export function buildMockSkillResolvedPaths(): ResolvedPaths {
  const homeDir = path.join(fixtureRoot, "global");
  const projectRoot = path.join(fixtureRoot, "project");

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

export function buildMockSkillRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  const resolvedPaths = buildMockSkillResolvedPaths();

  return {
    cwd: resolvedPaths.projectRoot,
    resolvedPaths,
    model: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      temperature: 0.2,
      ...overrides.model,
    },
    runtime: {
      maxAgentSteps: 8,
      fetchMemoryMaxAgentSteps: 3,
      autoMemoryForkMaxAgentSteps: 4,
      shellCommandTimeoutMs: 15_000,
      maxToolOutputChars: 12_000,
      maxConversationSummaryMessages: 10,
      autoCompactThresholdTokens: 120_000,
      compactRecentKeepGroups: 8,
      ...overrides.runtime,
    },
    tool: {
      approvalMode: "always",
      shellExecutable: "/bin/zsh",
      ...overrides.tool,
    },
    cli: {
      ...overrides.cli,
    },
  };
}
