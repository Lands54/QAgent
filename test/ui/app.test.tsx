import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { AppState } from "../../src/runtime/appState.js";
import { createEmptyState } from "../../src/runtime/appState.js";
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
});
