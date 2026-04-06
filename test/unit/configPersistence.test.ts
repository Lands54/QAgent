import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultBaseUrlForProvider,
  persistGlobalModelConfig,
  persistProjectModelConfig,
} from "../../src/config/configPersistence.js";
import { readJsonIfExists } from "../../src/utils/fs.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("configPersistence", () => {
  it("将 provider/model 写入项目配置，将 apiKey 写入全局配置", async () => {
    const root = await makeTempDir("qagent-config-");
    const paths = {
      cwd: root,
      homeDir: root,
      globalAgentDir: path.join(root, ".global-agent"),
      projectRoot: root,
      projectAgentDir: path.join(root, ".agent"),
      globalConfigPath: path.join(root, ".global-agent", "config.json"),
      projectConfigPath: path.join(root, ".agent", "config.json"),
      globalMemoryDir: path.join(root, ".global-agent", "memory"),
      projectMemoryDir: path.join(root, ".agent", "memory"),
      globalSkillsDir: path.join(root, ".global-agent", "skills"),
      projectSkillsDir: path.join(root, ".agent", "skills"),
      sessionRoot: path.join(root, ".agent", "sessions"),
    };

    await persistProjectModelConfig(paths, {
      provider: "openrouter",
      model: "openai/gpt-5",
      baseUrl: defaultBaseUrlForProvider("openrouter"),
    });
    await persistGlobalModelConfig(paths, {
      apiKey: "secret-key",
    });

    const projectConfig = await readJsonIfExists<{ model?: Record<string, string> }>(
      paths.projectConfigPath,
    );
    const globalConfig = await readJsonIfExists<{ model?: Record<string, string> }>(
      paths.globalConfigPath,
    );

    expect(projectConfig?.model?.provider).toBe("openrouter");
    expect(projectConfig?.model?.model).toBe("openai/gpt-5");
    expect(projectConfig?.model?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(globalConfig?.model?.apiKey).toBe("secret-key");
  });
});
