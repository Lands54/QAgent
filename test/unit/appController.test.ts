import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AppController } from "../../src/runtime/appController.js";
import type { RuntimeEvent, SessionEvent } from "../../src/types.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readEvents(projectDir: string, headId: string): Promise<SessionEvent[]> {
  const eventsPath = path.join(
    projectDir,
    ".agent",
    "sessions",
    "__heads",
    headId,
    "events.ndjson",
  );
  const raw = await readFile(eventsPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待条件满足超时。");
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

  it("会把 slash 与 ui-context 相关 typed journal 事件写入 events.ndjson", async () => {
    const projectDir = await makeTempDir("qagent-app-controller-events-");
    const controller = await AppController.create({
      cwd: projectDir,
    });

    try {
      await controller.submitInput("/debug ui-context on");
      await controller.submitInput("/help");

      const events = await readEvents(
        projectDir,
        controller.getState().activeWorkingHeadId,
      );
      expect(events.some((event) => {
        return (
          event.type === "runtime.ui_context.set"
          && event.payload.enabled === true
        );
      })).toBe(true);
      const appendedEvents = events.filter((event) => {
        return event.type === "conversation.entry.appended";
      });
      expect(appendedEvents.some((event) => {
        return (
          event.payload.entryKind === "ui-command"
          && event.payload.entry.modelMirror?.content === "[UI命令] /help"
        );
      })).toBe(true);
      expect(appendedEvents.some((event) => {
        return (
          event.payload.entryKind === "system-info"
          && event.payload.entry.ui?.content.includes("可用命令：")
        );
      })).toBe(true);
    } finally {
      await controller.dispose();
    }
  });

  it("slash 命令也会发出统一的 command.completed 运行事件", async () => {
    const projectDir = await makeTempDir("qagent-app-controller-command-event-");
    const controller = await AppController.create({
      cwd: projectDir,
    });
    const events: RuntimeEvent[] = [];
    const unsubscribe = controller.subscribeRuntimeEvents((event) => {
      events.push(event);
    });

    try {
      await controller.submitInput("/debug ui-context on");

      const commandEvent = events.find((event) => event.type === "command.completed");
      expect(commandEvent?.payload.domain).toBe("debug");
      expect(commandEvent?.payload.status).toBe("success");
      expect(commandEvent?.payload.code).toBe("debug.ui_context.updated");
    } finally {
      unsubscribe();
      await controller.dispose();
    }
  });

  it("非法书签名称会显示错误消息，而不是让 submitInput reject", async () => {
    const projectDir = await makeTempDir("qagent-app-controller-invalid-branch-");
    const controller = await AppController.create({
      cwd: projectDir,
    });

    try {
      await expect(controller.submitInput("/bookmark save Foo")).resolves.toBeUndefined();

      const lastMessage = controller.getState().uiMessages.at(-1);
      expect(lastMessage?.role).toBe("error");
      expect(lastMessage?.content).toContain("branch 名称必须匹配");
    } finally {
      await controller.dispose();
    }
  });

  it("非 slash 输入后台失败会显示错误消息", async () => {
    const projectDir = await makeTempDir("qagent-app-controller-input-error-");
    const controller = await AppController.create({
      cwd: projectDir,
    });
    const agentManager = (controller as unknown as {
      agentManager: {
        submitInputToActiveAgent: (input: string) => Promise<void>;
      };
    }).agentManager;
    vi.spyOn(agentManager, "submitInputToActiveAgent")
      .mockRejectedValue(new Error("queued input failed"));

    try {
      await expect(controller.submitInput("hello")).resolves.toBeUndefined();

      await waitForCondition(() => {
        return controller
          .getState()
          .uiMessages
          .some((message) => message.content.includes("queued input failed"));
      });

      const lastMessage = controller.getState().uiMessages.at(-1);
      expect(lastMessage?.role).toBe("error");
      expect(lastMessage?.title).toBe("Agent");
      expect(lastMessage?.content).toContain("发送输入失败");
      expect(controller.getState().status.mode).toBe("error");
    } finally {
      await controller.dispose();
    }
  });
});
