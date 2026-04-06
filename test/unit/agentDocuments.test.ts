import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadAgentInstructionLayers } from "../../src/context/agentDocuments.js";
import type { ResolvedPaths } from "../../src/types.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("loadAgentInstructionLayers", () => {
  it("按 global-agent -> project-agent 顺序加载说明文档", async () => {
    const homeDir = await makeTempDir("qagent-home-");
    const projectDir = await makeTempDir("qagent-project-");
    const globalAgentDir = path.join(homeDir, ".agent");
    const projectAgentDir = path.join(projectDir, ".agent");
    await mkdir(globalAgentDir, { recursive: true });
    await mkdir(projectAgentDir, { recursive: true });
    await writeFile(path.join(globalAgentDir, "AGENT.md"), "global rules", "utf8");
    await writeFile(path.join(projectAgentDir, "AGENTS.md"), "project rules", "utf8");

    const paths: ResolvedPaths = {
      cwd: projectDir,
      homeDir,
      globalAgentDir,
      projectRoot: projectDir,
      projectAgentDir,
      globalConfigPath: path.join(globalAgentDir, "config.json"),
      projectConfigPath: path.join(projectAgentDir, "config.json"),
      globalMemoryDir: path.join(globalAgentDir, "memory"),
      projectMemoryDir: path.join(projectAgentDir, "memory"),
      globalSkillsDir: path.join(globalAgentDir, "skills"),
      projectSkillsDir: path.join(projectAgentDir, "skills"),
      sessionRoot: path.join(projectAgentDir, "sessions"),
    };

    const layers = await loadAgentInstructionLayers(paths);

    expect(layers).toHaveLength(2);
    expect(layers[0]?.source).toBe("global-agent");
    expect(layers[0]?.content).toContain("global rules");
    expect(layers[1]?.source).toBe("project-agent");
    expect(layers[1]?.content).toContain("project rules");
  });
});
