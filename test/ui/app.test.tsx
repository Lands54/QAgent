import { render } from "ink-testing-library";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createEmptyState, type AppState } from "../../src/runtime/appState.js";
import { App } from "../../src/ui/App.js";

class FakeController {
  private readonly emitter = new EventEmitter();
  private state: AppState;

  public readonly submitInput = vi.fn(async () => {});
  public readonly approvePendingRequest = vi.fn(async () => {});
  public readonly interruptAgent = vi.fn(async () => {});
  public readonly requestExit = vi.fn(async () => {});
  public readonly switchAgentRelative = vi.fn(async () => {});

  public constructor() {
    this.state = createEmptyState("/tmp/project");
    this.state = {
      ...this.state,
      activeWorklineId: "head_main",
      activeWorklineName: "main",
      activeExecutorId: "head_main",
      activeExecutorKind: "interactive",
      activeBookmarkLabel: "branch=main",
      sessionId: "session_demo",
      shellCwd: "/tmp/project",
      currentTokenEstimate: 2400,
      autoCompactThresholdTokens: 120000,
      status: {
        mode: "idle",
        detail: "等待输入",
        updatedAt: new Date().toISOString(),
      },
      uiMessages: [
        {
          id: "msg-1",
          role: "info",
          content: "欢迎来到 QAgent",
          createdAt: new Date().toISOString(),
        },
      ],
      worklines: [
        {
          id: "head_main",
          sessionId: "session_demo",
          name: "main",
          attachmentMode: "branch",
          attachmentLabel: "branch=main",
          shellCwd: "/tmp/project",
          dirty: false,
          writeLock: "main",
          status: "idle",
          detail: "等待输入",
          executorKind: "interactive",
          active: true,
        },
      ],
    };
  }

  public getState(): AppState {
    return this.state;
  }

  public subscribe(listener: (state: AppState) => void): () => void {
    this.emitter.on("state", listener);
    return () => {
      this.emitter.off("state", listener);
    };
  }
}

async function typeInput(view: ReturnType<typeof render>, input: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const char of input) {
    view.stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("App", () => {
  it("能渲染基础 TUI 结构", () => {
    const controller = new FakeController();
    controller.getState().sessionRef = {
      mode: "branch",
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingHeadId: "head_main",
      workingHeadName: "main",
      sessionId: "session_demo",
      writerLeaseBranch: "main",
      active: true,
      dirty: false,
    };
    controller.getState().agents = [
      {
        id: "head_main",
        headId: "head_main",
        sessionId: "session_demo",
        name: "main",
        kind: "interactive",
        status: "idle",
        autoMemoryFork: true,
        retainOnCompletion: true,
        detail: "等待输入",
        shellCwd: "/tmp/project",
        dirty: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "head_worker",
        headId: "head_worker",
        sessionId: "session_worker",
        name: "worker",
        kind: "interactive",
        status: "idle",
        autoMemoryFork: true,
        retainOnCompletion: true,
        detail: "等待输入",
        shellCwd: "/tmp/project",
        dirty: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const view = render(<App controller={controller as never} />);

    expect(view.lastFrame()).toContain("QAgent CLI v1");
    expect(view.lastFrame()).toContain("欢迎来到 QAgent");
    expect(view.lastFrame()).toContain("session_demo");
    expect(view.lastFrame()).toContain("bookmark=branch=main");
    expect(view.lastFrame()).toContain("history: ↑/↓");
    expect(view.lastFrame()).toContain("工作线: 仅当前 1 条");
    expect(view.lastFrame()).toContain("complete: Tab");
    expect(view.lastFrame()).toContain("tokens: 2400/120000 (2.0%)");
    expect(view.lastFrame()).toContain("待机模式");
    expect(view.lastFrame()).toContain("今天的热身动作");
    expect(view.lastFrame()).toContain("现在是待机态");
  });

  it("在审批态显示明确的等待提示", () => {
    const controller = new FakeController();
    const state = controller.getState();
    state.pendingApproval = {
      id: "approval_1",
      summary: '执行 shell 命令：pwd',
      riskLevel: "medium",
      createdAt: new Date().toISOString(),
      toolCall: {
        id: "tool_1",
        name: "shell",
        createdAt: new Date().toISOString(),
        input: {
          command: "pwd",
        },
      },
    };

    const view = render(<App controller={controller as never} />);

    expect(view.lastFrame()).toContain("待审批的 Shell Tool 调用");
    expect(view.lastFrame()).toContain("[等待审批]");
    expect(view.lastFrame()).toContain("按 y 批准");
  });

  it("会在状态栏显示当前已发现的 skill 数量", () => {
    const controller = new FakeController();
    const state = controller.getState();
    state.availableSkills = [
      {
        id: "project:pdf-processing",
        name: "pdf-processing",
        description: "pdf",
        scope: "project",
        directoryPath: "/tmp/project/.agent/skills/pdf-processing",
        filePath: "/tmp/project/.agent/skills/pdf-processing/SKILL.md",
        content: "body",
      },
      {
        id: "global:api-testing",
        name: "api-testing",
        description: "api",
        scope: "global",
        directoryPath: "/tmp/home/.agent/skills/api-testing",
        filePath: "/tmp/home/.agent/skills/api-testing/SKILL.md",
        content: "body",
      },
    ];

    const view = render(<App controller={controller as never} />);

    expect(view.lastFrame()).toContain("skills=2");
  });

  it("当 fetch/save helper 正在运行时，会显示 fetching / saving 提示", () => {
    const controller = new FakeController();
    const state = controller.getState();
    state.agents = [
      {
        id: "head_main",
        headId: "head_main",
        sessionId: "session_demo",
        name: "main",
        kind: "interactive",
        status: "idle",
        autoMemoryFork: true,
        retainOnCompletion: true,
        detail: "等待输入",
        shellCwd: "/tmp/project",
        dirty: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "head_fetch",
        headId: "head_fetch",
        sessionId: "session_fetch",
        name: "fetch-memory-1",
        kind: "task",
        helperType: "fetch-memory",
        status: "running",
        autoMemoryFork: false,
        retainOnCompletion: true,
        detail: "正在筛选候选 memory",
        shellCwd: "/tmp/project",
        dirty: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "head_save",
        headId: "head_save",
        sessionId: "session_save",
        name: "auto-memory-1",
        kind: "task",
        helperType: "save-memory",
        status: "running",
        autoMemoryFork: false,
        retainOnCompletion: true,
        detail: "正在整理长期记忆",
        shellCwd: "/tmp/project",
        dirty: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    state.helperActivities = ["fetching memory...", "saving memory..."];

    const view = render(<App controller={controller as never} />);

    expect(view.lastFrame()).toContain("helper: fetching memory... | saving memory...");
  });

  it("会在本地处理 /help，不依赖后端 submitInput", async () => {
    const controller = new FakeController();
    const view = render(<App controller={controller as never} />);

    await typeInput(view, "/help");

    expect(controller.submitInput).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain("可用命令：");
    expect(view.lastFrame()).toContain("/exit");
  });

  it("会在本地处理 /exit，不依赖后端 submitInput", async () => {
    const controller = new FakeController();
    const view = render(<App controller={controller as never} />);

    await typeInput(view, "/exit");

    expect(controller.submitInput).not.toHaveBeenCalled();
    expect(controller.requestExit).toHaveBeenCalledTimes(1);
  });

  it("空闲态 Ctrl+C 会走与 /exit 相同的本地退出路径", async () => {
    const controller = new FakeController();
    const view = render(<App controller={controller as never} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.interruptAgent).not.toHaveBeenCalled();
    expect(controller.requestExit).toHaveBeenCalledTimes(1);
  });

});
