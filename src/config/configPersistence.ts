import type { ModelProvider, ResolvedPaths, RuntimeConfig } from "../types.js";
import { readJsonIfExists, writeJson } from "../utils/index.js";

interface PersistedRuntimeConfig {
  model?: Partial<RuntimeConfig["model"]>;
  runtime?: Partial<RuntimeConfig["runtime"]>;
  tool?: Partial<RuntimeConfig["tool"]>;
  gateway?: Partial<RuntimeConfig["gateway"]>;
  edge?: Partial<RuntimeConfig["edge"]>;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function mergePersistedConfig(
  current: PersistedRuntimeConfig,
  patch: PersistedRuntimeConfig,
): PersistedRuntimeConfig {
  return {
    ...current,
    model: {
      ...(current.model ?? {}),
      ...omitUndefined(patch.model ?? {}),
    },
    runtime: {
      ...(current.runtime ?? {}),
      ...omitUndefined(patch.runtime ?? {}),
    },
    tool: {
      ...(current.tool ?? {}),
      ...omitUndefined(patch.tool ?? {}),
    },
    gateway: {
      ...(current.gateway ?? {}),
      ...omitUndefined(patch.gateway ?? {}),
    },
    edge: {
      ...(current.edge ?? {}),
      ...omitUndefined(patch.edge ?? {}),
    },
  };
}

async function patchConfigFile(
  targetPath: string,
  patch: PersistedRuntimeConfig,
): Promise<void> {
  const current =
    (await readJsonIfExists<PersistedRuntimeConfig>(targetPath)) ?? {};
  await writeJson(targetPath, mergePersistedConfig(current, patch));
}

export function defaultBaseUrlForProvider(provider: ModelProvider): string {
  return provider === "openrouter"
    ? "https://openrouter.ai/api/v1"
    : "https://api.openai.com/v1";
}

export async function persistProjectModelConfig(
  paths: ResolvedPaths,
  patch: Partial<RuntimeConfig["model"]>,
): Promise<void> {
  await patchConfigFile(paths.projectConfigPath, {
    model: patch,
  });
}

export async function persistGlobalModelConfig(
  paths: ResolvedPaths,
  patch: Partial<RuntimeConfig["model"]>,
): Promise<void> {
  await patchConfigFile(paths.globalConfigPath, {
    model: patch,
  });
}

export async function persistProjectRuntimeConfig(
  paths: ResolvedPaths,
  patch: Partial<RuntimeConfig["runtime"]>,
): Promise<void> {
  await patchConfigFile(paths.projectConfigPath, {
    runtime: patch,
  });
}

export async function persistGlobalRuntimeConfig(
  paths: ResolvedPaths,
  patch: Partial<RuntimeConfig["runtime"]>,
): Promise<void> {
  await patchConfigFile(paths.globalConfigPath, {
    runtime: patch,
  });
}
