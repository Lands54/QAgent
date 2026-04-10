import { rm } from "node:fs/promises";
import path from "node:path";

import type { GatewayManifest } from "./types.js";
import { readJsonIfExists, writeJson } from "../utils/index.js";

export function getGatewayManifestPath(sessionRoot: string): string {
  return path.join(sessionRoot, "gateway-manifest.json");
}

export async function readGatewayManifest(
  sessionRoot: string,
): Promise<GatewayManifest | undefined> {
  return readJsonIfExists<GatewayManifest>(getGatewayManifestPath(sessionRoot));
}

export async function writeGatewayManifest(
  sessionRoot: string,
  manifest: GatewayManifest,
): Promise<void> {
  await writeJson(getGatewayManifestPath(sessionRoot), manifest);
}

export async function clearGatewayManifest(sessionRoot: string): Promise<void> {
  await rm(getGatewayManifestPath(sessionRoot), { force: true });
}
