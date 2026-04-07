import os from "node:os";
import path from "node:path";

import { defaultBaseUrlForProvider } from "./configPersistence.js";
import type {
  CliOptions,
  ModelProvider,
  ResolvedPaths,
  RuntimeConfig,
} from "../types.js";
import { readJsonIfExists } from "../utils/index.js";

interface PartialRuntimeConfig {
  model?: Partial<RuntimeConfig["model"]>;
  runtime?: Partial<RuntimeConfig["runtime"]>;
  tool?: Partial<RuntimeConfig["tool"]>;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function pickLastDefined<T>(values: Array<T | undefined>): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const candidate = values[index];
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

function isModelProvider(value: string | undefined): value is ModelProvider {
  return value === "openai" || value === "openrouter";
}

function defaultAppName(provider: ModelProvider): string | undefined {
  return provider === "openrouter" ? "QAgent CLI" : undefined;
}

function resolveProvider(
  cliOptions: CliOptions,
  partials: Array<PartialRuntimeConfig | undefined>,
): ModelProvider {
  const configuredProvider = pickLastDefined<ModelProvider>(
    partials.map((partial) => {
      const provider = partial?.model?.provider;
      return typeof provider === "string" && isModelProvider(provider)
        ? provider
        : undefined;
    }),
  );

  if (configuredProvider) {
    return configuredProvider;
  }

  if (isModelProvider(cliOptions.provider)) {
    return cliOptions.provider;
  }

  const envProvider =
    process.env.QAGENT_PROVIDER ?? process.env.QAGENT_MODEL_PROVIDER;
  if (isModelProvider(envProvider)) {
    return envProvider;
  }

  if (process.env.OPENROUTER_API_KEY) {
    return "openrouter";
  }

  return "openai";
}

function buildResolvedPaths(cliOptions: CliOptions): ResolvedPaths {
  const cwd = path.resolve(cliOptions.cwd ?? process.cwd());
  const homeDir = os.homedir();
  const globalAgentDir = path.join(homeDir, ".agent");
  const projectRoot = cwd;
  const projectAgentDir = path.join(projectRoot, ".agent");

  return {
    cwd,
    homeDir,
    globalAgentDir,
    projectRoot,
    projectAgentDir,
    globalConfigPath: path.join(globalAgentDir, "config.json"),
    projectConfigPath: path.join(projectAgentDir, "config.json"),
    explicitConfigPath: cliOptions.configPath
      ? path.resolve(projectRoot, cliOptions.configPath)
      : undefined,
    globalMemoryDir: path.join(globalAgentDir, "memory"),
    projectMemoryDir: path.join(projectAgentDir, "memory"),
    globalSkillsDir: path.join(globalAgentDir, "skills"),
    projectSkillsDir: path.join(projectAgentDir, "skills"),
    sessionRoot: path.join(projectAgentDir, "sessions"),
  };
}

function mergeConfig(
  baseConfig: RuntimeConfig,
  partial?: PartialRuntimeConfig,
): RuntimeConfig {
  if (!partial) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    model: {
      ...baseConfig.model,
      ...omitUndefined(partial.model ?? {}),
    },
    runtime: {
      ...baseConfig.runtime,
      ...omitUndefined(partial.runtime ?? {}),
    },
    tool: {
      ...baseConfig.tool,
      ...omitUndefined(partial.tool ?? {}),
    },
  };
}

function fromEnv(provider: ModelProvider): PartialRuntimeConfig {
  const maxSteps = process.env.QAGENT_MAX_AGENT_STEPS;
  const fetchMemoryMaxSteps = process.env.QAGENT_FETCH_MEMORY_MAX_AGENT_STEPS;
  const autoMemoryForkMaxSteps =
    process.env.QAGENT_AUTO_MEMORY_FORK_MAX_AGENT_STEPS;
  const shellTimeout = process.env.QAGENT_SHELL_TIMEOUT_MS;
  const autoCompactThreshold = process.env.QAGENT_AUTO_COMPACT_THRESHOLD_TOKENS;
  const compactRecentKeepGroups = process.env.QAGENT_COMPACT_RECENT_KEEP_GROUPS;
  const envProvider =
    process.env.QAGENT_PROVIDER ?? process.env.QAGENT_MODEL_PROVIDER;
  const apiKey =
    process.env.QAGENT_API_KEY ??
    (provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : process.env.OPENAI_API_KEY);
  const baseUrl =
    process.env.QAGENT_BASE_URL ??
    (provider === "openrouter"
      ? process.env.OPENROUTER_BASE_URL
      : process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE);

  return {
    model: {
      provider: isModelProvider(envProvider) ? envProvider : undefined,
      apiKey,
      baseUrl,
      model: process.env.QAGENT_MODEL,
      systemPrompt: process.env.QAGENT_SYSTEM_PROMPT,
      appName:
        process.env.QAGENT_APP_NAME ??
        process.env.QAGENT_OPENROUTER_APP_NAME ??
        process.env.OPENROUTER_APP_NAME,
      appUrl:
        process.env.QAGENT_APP_URL ??
        process.env.QAGENT_OPENROUTER_APP_URL ??
        process.env.OPENROUTER_SITE_URL,
    },
    runtime: {
      maxAgentSteps: maxSteps ? Number(maxSteps) : undefined,
      fetchMemoryMaxAgentSteps: fetchMemoryMaxSteps
        ? Number(fetchMemoryMaxSteps)
        : undefined,
      autoMemoryForkMaxAgentSteps: autoMemoryForkMaxSteps
        ? Number(autoMemoryForkMaxSteps)
        : undefined,
      shellCommandTimeoutMs: shellTimeout ? Number(shellTimeout) : undefined,
      autoCompactThresholdTokens: autoCompactThreshold ? Number(autoCompactThreshold) : undefined,
      compactRecentKeepGroups: compactRecentKeepGroups ? Number(compactRecentKeepGroups) : undefined,
    },
    tool: {
      approvalMode: process.env.QAGENT_APPROVAL_MODE as RuntimeConfig["tool"]["approvalMode"] | undefined,
      shellExecutable: process.env.QAGENT_SHELL ?? process.env.SHELL,
    },
  };
}

export async function loadRuntimeConfig(
  cliOptions: CliOptions,
): Promise<RuntimeConfig> {
  const resolvedPaths = buildResolvedPaths(cliOptions);

  const globalConfig =
    (await readJsonIfExists<PartialRuntimeConfig>(resolvedPaths.globalConfigPath)) ??
    undefined;
  const projectConfig =
    (await readJsonIfExists<PartialRuntimeConfig>(resolvedPaths.projectConfigPath)) ??
    undefined;
  const explicitConfig = resolvedPaths.explicitConfigPath
    ? await readJsonIfExists<PartialRuntimeConfig>(resolvedPaths.explicitConfigPath)
    : undefined;
  const cliConfig: PartialRuntimeConfig = {
    model: {
      provider: cliOptions.provider,
      model: cliOptions.model,
    },
  };
  const provider = resolveProvider(cliOptions, [
    globalConfig,
    projectConfig,
    explicitConfig,
    cliConfig,
  ]);

  const defaults: RuntimeConfig = {
    cwd: resolvedPaths.cwd,
    resolvedPaths,
    model: {
      provider,
      baseUrl: defaultBaseUrlForProvider(provider),
      model: "gpt-4.1-mini",
      temperature: 0.2,
      systemPrompt:
        "你是 QAgent，一个命令行中的自治代理。你只能通过 shell 工具与外部系统交互。",
      appName: defaultAppName(provider),
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
      shellExecutable: process.env.SHELL ?? "/bin/zsh",
    },
    cli: {
      initialPrompt: cliOptions.initialPrompt,
      resumeSessionId: cliOptions.resumeSessionId,
      explicitConfigPath: resolvedPaths.explicitConfigPath,
    },
  };

  let merged = mergeConfig(defaults, globalConfig);
  merged = mergeConfig(merged, projectConfig);
  merged = mergeConfig(merged, explicitConfig);
  merged = mergeConfig(merged, fromEnv(provider));
  merged = mergeConfig(merged, cliConfig);

  return {
    ...merged,
    cwd: resolvedPaths.cwd,
    resolvedPaths,
    cli: {
      ...merged.cli,
      initialPrompt: cliOptions.initialPrompt,
      resumeSessionId: cliOptions.resumeSessionId,
      explicitConfigPath: resolvedPaths.explicitConfigPath,
    },
  };
}
