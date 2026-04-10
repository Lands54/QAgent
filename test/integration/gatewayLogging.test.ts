import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/index.js";
import { GatewayServer } from "../../src/gateway/index.js";
import { DEFAULT_JSON_BODY_LIMIT_BYTES } from "../../src/utils/index.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function stdoutFrom(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join("");
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("Gateway logging", () => {
  it("waitUntilStopped 会在 gateway stop 后完成", async () => {
    const projectDir = await makeTempDir("qagent-gateway-stop-");
    const server = await GatewayServer.create({ cwd: projectDir });
    await server.listen();

    const stopped = server.waitUntilStopped().then(() => "resolved");
    await server.stop("test-cleanup");
    await expect(Promise.race([
      stopped,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ])).resolves.toBe("resolved");
  });

  it("会写入项目内 gateway 日志，并且只记录元数据", async () => {
    const projectDir = await makeTempDir("qagent-gateway-logging-");
    const server = await GatewayServer.create({ cwd: projectDir });
    const { baseUrl, logPath } = await server.listen();
    const secret = "UNIQUE_GATEWAY_LOG_SECRET";

    try {
      const healthResponse = await fetch(`${baseUrl}/api/health`);
      const health = await healthResponse.json() as { logPath?: string };
      expect(health.logPath).toBe(logPath);
      expect(logPath).toBe(path.join(projectDir, ".agent", "logs", "gateway.log"));

      const openResponse = await fetch(`${baseUrl}/api/clients/open`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientLabel: "tui",
        }),
      });
      const opened = await openResponse.json() as { clientId: string };

      const sseResponse = await fetch(
        `${baseUrl}/api/events?clientId=${encodeURIComponent(opened.clientId)}`,
        {
          headers: {
            accept: "text/event-stream",
          },
        },
      );
      expect(sseResponse.ok).toBe(true);
      await sseResponse.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 0));

      await fetch(`${baseUrl}/api/input`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId: opened.clientId,
          input: `/help ${secret}`,
        }),
      });

      await fetch(`${baseUrl}/api/clients/${encodeURIComponent(opened.clientId)}`, {
        method: "DELETE",
      });

      const statusStdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      await runCli(["--cwd", projectDir, "gateway", "status"]);
      const statusOutput = stdoutFrom(statusStdout);
      statusStdout.mockRestore();
      expect(statusOutput).toContain(`log: ${logPath}`);

      const serveStdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      await runCli(["--cwd", projectDir, "gateway", "serve"]);
      const serveOutput = stdoutFrom(serveStdout);
      serveStdout.mockRestore();
      expect(serveOutput).toContain("gateway 已在运行");
      expect(serveOutput).toContain(`log: ${logPath}`);
    } finally {
      await server.stop("test-cleanup");
    }

    const logContents = await readFile(logPath, "utf8");
    expect(logContents).toContain("\"event\":\"gateway.listen\"");
    expect(logContents).toContain("\"event\":\"client.open\"");
    expect(logContents).toContain("\"event\":\"executor.attach\"");
    expect(logContents).toContain("\"event\":\"sse.connect\"");
    expect(logContents).toContain("\"event\":\"sse.disconnect\"");
    expect(logContents).toContain("\"event\":\"input.received\"");
    expect(logContents).toContain("\"event\":\"client.close\"");
    expect(logContents).toContain("\"event\":\"gateway.stop.completed\"");
    expect(logContents).toContain("\"inputLength\"");
    expect(logContents).not.toContain(secret);
    expect(logContents).not.toContain("/help");
  });

  it("会拒绝过大的 JSON 请求体", async () => {
    const projectDir = await makeTempDir("qagent-gateway-body-limit-");
    const server = await GatewayServer.create({ cwd: projectDir });
    const { baseUrl } = await server.listen();

    try {
      const response = await fetch(`${baseUrl}/api/clients/open`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "x".repeat(DEFAULT_JSON_BODY_LIMIT_BYTES + 1),
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: "请求 body 过大。",
      });
    } finally {
      await server.stop("test-cleanup");
    }
  });
});
