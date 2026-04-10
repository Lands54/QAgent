import { rm } from "node:fs/promises";
import path from "node:path";

import type { EdgeManifest } from "../types.js";
import { readJsonIfExists, writeJson } from "../utils/index.js";

export function getEdgeManifestPath(globalAgentDir: string): string {
  return path.join(globalAgentDir, "edge-manifest.json");
}

export async function readEdgeManifest(
  globalAgentDir: string,
): Promise<EdgeManifest | undefined> {
  return readJsonIfExists<EdgeManifest>(getEdgeManifestPath(globalAgentDir));
}

export async function writeEdgeManifest(
  globalAgentDir: string,
  manifest: EdgeManifest,
): Promise<void> {
  await writeJson(getEdgeManifestPath(globalAgentDir), manifest);
}

export async function clearEdgeManifest(globalAgentDir: string): Promise<void> {
  await rm(getEdgeManifestPath(globalAgentDir), { force: true });
}
