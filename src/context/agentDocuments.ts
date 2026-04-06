import path from "node:path";

import type { InstructionLayer, ResolvedPaths } from "../types.js";
import { createId, pathExists, readTextIfExists } from "../utils/index.js";

async function readFirstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return readTextIfExists(candidate);
    }
  }

  return undefined;
}

export async function loadAgentInstructionLayers(
  paths: ResolvedPaths,
): Promise<InstructionLayer[]> {
  const globalContent = await readFirstExisting([
    path.join(paths.globalAgentDir, "AGENT.md"),
    path.join(paths.globalAgentDir, "AGENTS.md"),
  ]);

  const projectContent = await readFirstExisting([
    path.join(paths.projectRoot, "AGENT.md"),
    path.join(paths.projectRoot, "AGENTS.md"),
    path.join(paths.projectAgentDir, "AGENT.md"),
    path.join(paths.projectAgentDir, "AGENTS.md"),
  ]);

  const layers: InstructionLayer[] = [];

  if (globalContent?.trim()) {
    layers.push({
      id: createId("instruction"),
      source: "global-agent",
      title: "Global AGENT",
      content: globalContent.trim(),
      priority: 100,
    });
  }

  if (projectContent?.trim()) {
    layers.push({
      id: createId("instruction"),
      source: "project-agent",
      title: "Project AGENT",
      content: projectContent.trim(),
      priority: 90,
    });
  }

  return layers;
}
