import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRuntimeConfig } from "../../src/config/loadConfig.js";

const originalEnv = { ...process.env };

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("loadRuntimeConfig", () => {
  it("按 global -> project -> env -> cli 的顺序合并配置", async () => {
    const tempHome = await makeTempDir("qagent-home-");
    const tempProject = await makeTempDir("qagent-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    await mkdir(path.join(tempHome, ".agent"), { recursive: true });
    await mkdir(path.join(tempProject, ".agent"), { recursive: true });
    await writeFile(
      path.join(tempHome, ".agent", "config.json"),
      JSON.stringify({
        model: {
          baseUrl: "https://global.example/v1",
          model: "global-model",
        },
        runtime: {
          maxAgentSteps: 3,
          fetchMemoryMaxAgentSteps: 5,
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(tempProject, ".agent", "config.json"),
      JSON.stringify({
        model: {
          model: "project-model",
        },
        tool: {
          approvalMode: "risky",
        },
      }),
      "utf8",
    );

    process.env.HOME = tempHome;
    process.env.QAGENT_MODEL = "env-model";
    process.env.QAGENT_SHELL_TIMEOUT_MS = "3333";
    process.env.QAGENT_MODEL_REQUEST_TIMEOUT_MS = "4444";
    process.env.QAGENT_AUTO_MEMORY_FORK_MAX_AGENT_STEPS = "7";

    const config = await loadRuntimeConfig({
      cwd: tempProject,
      model: "cli-model",
    });

    expect(config.model.provider).toBe("openai");
    expect(config.model.baseUrl).toBe("https://global.example/v1");
    expect(config.model.model).toBe("cli-model");
    expect(config.runtime.maxAgentSteps).toBe(3);
    expect(config.runtime.fetchMemoryMaxAgentSteps).toBe(5);
    expect(config.runtime.autoMemoryForkMaxAgentSteps).toBe(7);
    expect(config.runtime.shellCommandTimeoutMs).toBe(3333);
    expect(config.model.requestTimeoutMs).toBe(4444);
    expect(config.tool.approvalMode).toBe("risky");
    expect(config.resolvedPaths.projectAgentDir).toBe(
      path.join(tempProject, ".agent"),
    );
    expect(config.resolvedPaths.globalAgentDir).toBe(path.join(tempHome, ".agent"));
  });

  it("支持通过 OpenRouter 环境变量自动切换 provider 与默认配置", async () => {
    const tempHome = await makeTempDir("qagent-home-");
    const tempProject = await makeTempDir("qagent-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    await mkdir(path.join(tempHome, ".agent"), { recursive: true });
    await mkdir(path.join(tempProject, ".agent"), { recursive: true });

    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.OPENROUTER_APP_NAME = "QAgent Test";
    process.env.OPENROUTER_SITE_URL = "https://example.com/qagent";

    const config = await loadRuntimeConfig({
      cwd: tempProject,
    });

    expect(config.model.provider).toBe("openrouter");
    expect(config.model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.model.apiKey).toBe("or-key");
    expect(config.model.appName).toBe("QAgent Test");
    expect(config.model.appUrl).toBe("https://example.com/qagent");
    expect(config.runtime.fetchMemoryMaxAgentSteps).toBe(3);
    expect(config.runtime.autoMemoryForkMaxAgentSteps).toBe(4);
  });

  it("环境变量 provider 覆盖项目配置时会同步使用对应默认值", async () => {
    const tempHome = await makeTempDir("qagent-home-");
    const tempProject = await makeTempDir("qagent-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    await mkdir(path.join(tempHome, ".agent"), { recursive: true });
    await mkdir(path.join(tempProject, ".agent"), { recursive: true });
    await writeFile(
      path.join(tempProject, ".agent", "config.json"),
      JSON.stringify({
        model: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
      "utf8",
    );

    process.env.QAGENT_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "or-key";

    const config = await loadRuntimeConfig({
      cwd: tempProject,
    });

    expect(config.model.provider).toBe("openrouter");
    expect(config.model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.model.apiKey).toBe("or-key");
    expect(config.model.appName).toBe("QAgent CLI");
  });

  it("CLI provider 覆盖项目配置时会同步使用对应默认 baseUrl", async () => {
    const tempHome = await makeTempDir("qagent-home-");
    const tempProject = await makeTempDir("qagent-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    await mkdir(path.join(tempHome, ".agent"), { recursive: true });
    await mkdir(path.join(tempProject, ".agent"), { recursive: true });
    await writeFile(
      path.join(tempProject, ".agent", "config.json"),
      JSON.stringify({
        model: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
      "utf8",
    );

    const config = await loadRuntimeConfig({
      cwd: tempProject,
      provider: "openrouter",
    });

    expect(config.model.provider).toBe("openrouter");
    expect(config.model.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("支持远程 gateway / edge 配置", async () => {
    const tempHome = await makeTempDir("qagent-home-");
    const tempProject = await makeTempDir("qagent-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    await mkdir(path.join(tempHome, ".agent"), { recursive: true });
    await mkdir(path.join(tempProject, ".agent"), { recursive: true });

    process.env.QAGENT_TRANSPORT_MODE = "remote";
    process.env.QAGENT_EDGE_BASE_URL = "https://edge.example.com";
    process.env.QAGENT_EDGE_API_TOKEN = "env-token";

    const config = await loadRuntimeConfig({
      cwd: tempProject,
      workspaceId: "workspace-1",
      edgePort: 9001,
    });

    expect(config.gateway.transportMode).toBe("remote");
    expect(config.gateway.workspaceId).toBe("workspace-1");
    expect(config.gateway.edgeBaseUrl).toBe("https://edge.example.com");
    expect(config.gateway.apiToken).toBe("env-token");
    expect(config.edge.port).toBe(9001);
    expect(config.edge.bindHost).toBe("127.0.0.1");
  });
});
