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

  public constructor() {
    this.state = createEmptyState("/tmp/project");
    this.state = {
      ...this.state,
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

describe("App", () => {
  it("能渲染基础 TUI 结构", () => {
    const controller = new FakeController();
    controller.getState().sessionRef = {
      mode: "branch",
      name: "main",
      label: "branch=main",
      headNodeId: "node_main",
      workingSessionId: "session_demo",
      dirty: false,
    };
    const view = render(<App controller={controller as never} />);

    expect(view.lastFrame()).toContain("QAgent CLI v1");
    expect(view.lastFrame()).toContain("欢迎来到 QAgent");
    expect(view.lastFrame()).toContain("session_demo");
    expect(view.lastFrame()).toContain("branch=main");
    expect(view.lastFrame()).toContain("history: ↑/↓");
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
});
