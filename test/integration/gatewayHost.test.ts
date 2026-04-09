import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GatewayHost } from "../../src/gateway/gatewayHost.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeProjectConfig(projectDir: string): Promise<void> {
  await mkdir(path.join(projectDir, ".agent"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".agent", "config.json"),
    JSON.stringify({
      model: {
        provider: "openai",
        model: "test-model",
      },
      tool: {
        shellExecutable: process.platform === "win32"
          ? "powershell.exe"
          : process.env.SHELL ?? "/bin/zsh",
      },
    }),
    "utf8",
  );
}

describe("GatewayHost", () => {
  const hosts: GatewayHost[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  });

  it("work close 成功后不会在同步客户端上下文时再次报错", async () => {
    const projectDir = await makeTempDir("qagent-gateway-host-");
    await writeProjectConfig(projectDir);
    const host = await GatewayHost.create({
      cwd: projectDir,
    });
    hosts.push(host);

    const opened = await host.openClient({
      clientLabel: "api",
    });

    const created = await host.executeCommand({
      commandId: "cmd_create",
      clientId: opened.clientId,
      request: {
        domain: "work",
        action: "new",
        name: "worker",
      },
    });
    expect(created.result.status).toBe("success");

    const switched = await host.executeCommand({
      commandId: "cmd_switch",
      clientId: opened.clientId,
      request: {
        domain: "work",
        action: "switch",
        worklineId: "main",
      },
    });
    expect(switched.result.status).toBe("success");

    const closed = await host.executeCommand({
      commandId: "cmd_close",
      clientId: opened.clientId,
      request: {
        domain: "work",
        action: "close",
        worklineId: "worker",
      },
    });
    expect(closed.result.status).toBe("success");
    expect(closed.result.code).toBe("work.closed");

    const list = await host.executeCommand({
      commandId: "cmd_list",
      clientId: opened.clientId,
      request: {
        domain: "work",
        action: "list",
      },
    });
    expect(list.result.status).toBe("success");
    expect((list.result.payload as { worklines: Array<{ name: string }> }).worklines).toEqual([
      expect.objectContaining({ name: "main" }),
    ]);

    const state = await host.getState(opened.clientId);
    expect(state.state.activeWorklineName).toBe("main");
  });
});
