import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AppController } from "../../src/runtime/appController.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("AppController", () => {
  it("会把 slash 命令返回消息写回当前 agent 的 UI", async () => {
    const projectDir = await makeTempDir("qagent-app-controller-");
    const controller = await AppController.create({
      cwd: projectDir,
    });

    try {
      await controller.submitInput("/help");

      const contents = controller.getState().uiMessages.map((message) => message.content);
      expect(contents.some((content) => content.includes("可用命令："))).toBe(true);
      expect(contents.some((content) => content.includes("/help"))).toBe(true);
    } finally {
      await controller.dispose();
    }
  });
});
