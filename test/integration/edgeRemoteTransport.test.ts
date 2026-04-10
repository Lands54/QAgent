import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { EdgeServer } from "../../src/edge/index.js";
import { BackendClientController, GatewayServer } from "../../src/gateway/index.js";
import { DEFAULT_JSON_BODY_LIMIT_BYTES } from "../../src/utils/index.js";

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

function toWebSocketUrl(baseUrl: string): string {
  return baseUrl.replace(/^http:/u, "ws:").replace(/^https:/u, "wss:");
}

function timeoutAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

async function createFakeEdgeServer(): Promise<{
  baseUrl: string;
  server: WebSocketServer;
}> {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake edge server 未能获取监听端口。");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
  };
}

async function closeFakeEdgeServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("Edge remote transport", () => {
  it("edge stop 可以安全处理重复调用", async () => {
    const tempHome = await makeTempDir("qagent-edge-home-");
    const tempProject = await makeTempDir("qagent-edge-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const edgeServer = await EdgeServer.create({
      cwd: tempProject,
      apiToken: "edge-secret-token",
      edgePort: 0,
    });
    await edgeServer.listen();

    await Promise.all([
      edgeServer.stop("test-cleanup"),
      edgeServer.stop("test-cleanup"),
    ]);
    await edgeServer.stop("test-cleanup");
  });

  it("edge 收到非法 gateway WebSocket 帧会关闭连接", async () => {
    const tempHome = await makeTempDir("qagent-edge-home-");
    const tempProject = await makeTempDir("qagent-edge-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const apiToken = "edge-secret-token";
    const edgeServer = await EdgeServer.create({
      cwd: tempProject,
      apiToken,
      edgePort: 0,
    });
    const { baseUrl } = await edgeServer.listen();
    let socket: WebSocket | undefined;

    try {
      const closed = new Promise<number>((resolve, reject) => {
        socket = new WebSocket(
          `${toWebSocketUrl(baseUrl)}/internal/gateways/connect`,
          {
            headers: {
              authorization: `Bearer ${apiToken}`,
            },
          },
        );
        socket.once("open", () => {
          socket?.send("{");
        });
        socket.once("close", (code) => resolve(code));
        socket.once("error", reject);
      });

      await expect(Promise.race([
        closed,
        timeoutAfter(2_000, "等待 edge 关闭非法 WebSocket 帧超时。"),
      ])).resolves.toBe(1003);
    } finally {
      socket?.close();
      await edgeServer.stop("test-cleanup");
    }
  });

  it("edge 会拒绝过大的 JSON 请求体", async () => {
    const tempHome = await makeTempDir("qagent-edge-home-");
    const tempProject = await makeTempDir("qagent-edge-project-");
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const apiToken = "edge-secret-token";
    const edgeServer = await EdgeServer.create({
      cwd: tempProject,
      apiToken,
      edgePort: 0,
    });
    const { baseUrl } = await edgeServer.listen();

    try {
      const response = await fetch(
        `${baseUrl}/v1/workspaces/${encodeURIComponent("workspace-body-limit")}/input`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiToken}`,
            "content-type": "application/json",
          },
          body: "x".repeat(DEFAULT_JSON_BODY_LIMIT_BYTES + 1),
        },
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: "请求 body 过大。",
      });
    } finally {
      await edgeServer.stop("test-cleanup");
    }
  });

  it("gateway bridge 收到非法 edge WebSocket 帧会关闭连接", async () => {
    const tempProject = await makeTempDir("qagent-edge-project-");
    const { baseUrl: fakeEdgeBaseUrl, server: fakeEdgeServer } =
      await createFakeEdgeServer();
    const closed = new Promise<number>((resolve, reject) => {
      fakeEdgeServer.once("connection", (socket) => {
        socket.once("message", () => {
          socket.send("{");
        });
        socket.once("close", (code) => resolve(code));
        socket.once("error", reject);
      });
      fakeEdgeServer.once("error", reject);
    });

    const gatewayServer = await GatewayServer.create({
      cwd: tempProject,
      transportMode: "local",
      workspaceId: "workspace-invalid-frame-test",
      edgeBaseUrl: fakeEdgeBaseUrl,
      apiToken: "edge-secret-token",
    });
    await gatewayServer.listen();

    try {
      await expect(Promise.race([
        closed,
        timeoutAfter(2_000, "等待 gateway bridge 关闭非法 WebSocket 帧超时。"),
      ])).resolves.toBe(1003);
    } finally {
      await gatewayServer.stop("test-cleanup");
      await closeFakeEdgeServer(fakeEdgeServer);
    }
  });

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
  }, 10_000);
});
