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

  it("在 ui-context 开启后会按顺序把 slash 命令与结果镜像进模型上下文", async () => {
    const projectDir = await makeTempDir("qagent-app-controller-ui-context-");
    const controller = await AppController.create({
      cwd: projectDir,
    });

    try {
      await controller.submitInput("/debug ui-context on");
      await controller.submitInput("/help");

      const modelContents = controller
        .getState()
        .modelMessages
        .map((message) => message.content);

      expect(modelContents).toContain("[UI命令] /debug ui-context on");
      expect(
        modelContents.some((content) => content.includes("[UI结果][INFO] ui-context 已切换为 on。")),
      ).toBe(true);
      expect(modelContents).toContain("[UI命令] /help");
      expect(
        modelContents.some((content) => content.includes("[UI结果][INFO] 可用命令：")),
      ).toBe(true);
    } finally {
      await controller.dispose();
    }
  });

  it("在 ui-context 关闭时 slash 命令不会进入模型上下文", async () => {
    const projectDir = await makeTempDir("qagent-app-controller-ui-context-off-");
    const controller = await AppController.create({
      cwd: projectDir,
    });

    try {
      await controller.submitInput("/help");

      expect(controller.getState().modelMessages).toEqual([]);
    } finally {
      await controller.dispose();
    }
  });
});
