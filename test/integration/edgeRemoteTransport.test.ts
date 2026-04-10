import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EdgeServer } from "../../src/edge/index.js";
import { BackendClientController, GatewayServer } from "../../src/gateway/index.js";

const originalEnv = { ...process.env };

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待条件满足超时。");
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("Edge remote transport", () => {
  it("remote controller 能通过 edge attach 到 workspace gateway", async () => {
    const tempHome = await makeTempDir("qagent-edge-home-");
    const tempProject = await makeTempDir("qagent-edge-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    await mkdir(path.join(tempHome, ".agent"), { recursive: true });
    await mkdir(path.join(tempProject, ".agent"), { recursive: true });

    const workspaceId = "workspace-remote-test";
    const apiToken = "edge-secret-token";

    const edgeServer = await EdgeServer.create({
      cwd: tempProject,
      apiToken,
      edgePort: 0,
    });
    const { baseUrl: edgeBaseUrl } = await edgeServer.listen();

    const gatewayServer = await GatewayServer.create({
      cwd: tempProject,
      transportMode: "local",
      workspaceId,
      edgeBaseUrl,
      apiToken,
    });
    await gatewayServer.listen();

    try {
      await waitForCondition(async () => {
        const response = await fetch(
          `${edgeBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/health`,
          {
            headers: {
              authorization: `Bearer ${apiToken}`,
            },
          },
        );
        if (!response.ok) {
          return false;
        }
        const payload = await response.json() as { online?: boolean };
        return payload.online === true;
      });

      const controller = await BackendClientController.create({
        cliOptions: {
          cwd: tempProject,
          transportMode: "remote",
          workspaceId,
          edgeBaseUrl,
          apiToken,
        },
        clientLabel: "cli",
      });

      try {
        await controller.submitInput("/help");
        await waitForCondition(() => {
          return controller
            .getState()
            .uiMessages
            .some((message) => message.content.includes("可用命令："));
        });
      } finally {
        await controller.dispose();
      }
    } finally {
      await gatewayServer.stop("test-cleanup");
      await edgeServer.stop("test-cleanup");
    }
  });
});
