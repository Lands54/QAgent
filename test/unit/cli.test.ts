import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandResult, RuntimeEvent } from "../../src/types.js";

const {
  mockRender,
  mockAppComponent,
  mockServeGateway,
  mockGetGatewayStatus,
  mockStopGateway,
  mockServeEdge,
  mockGetEdgeStatus,
  mockStopEdge,
  mockControllerCreate,
} = vi.hoisted(() => ({
  mockRender: vi.fn(),
  mockAppComponent: Symbol("App"),
  mockServeGateway: vi.fn(),
  mockGetGatewayStatus: vi.fn(),
  mockStopGateway: vi.fn(),
  mockServeEdge: vi.fn(),
  mockGetEdgeStatus: vi.fn(),
  mockStopEdge: vi.fn(),
  mockControllerCreate: vi.fn(),
}));

vi.mock("ink", () => ({
  render: mockRender,
}));

vi.mock("../../src/ui/index.js", () => ({
  App: mockAppComponent,
}));

vi.mock("../../src/gateway/index.js", () => ({
  BackendClientController: {
    create: mockControllerCreate,
  },
  serveGateway: mockServeGateway,
  getGatewayStatus: mockGetGatewayStatus,
  stopGateway: mockStopGateway,
}));

vi.mock("../../src/edge/index.js", () => ({
  serveEdge: mockServeEdge,
  getEdgeStatus: mockGetEdgeStatus,
  stopEdge: mockStopEdge,
}));

import { runCli } from "../../src/cli/index.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

function createCommandResult(
  overrides: Partial<CommandResult> = {},
): CommandResult {
  return {
    status: "success",
    code: "command.ok",
    exitCode: 0,
    messages: [
      {
        level: "info",
        text: "命令执行成功",
      },
    ],
    ...overrides,
  };
}

function createRuntimeEvent(type: RuntimeEvent["type"]): RuntimeEvent {
  return {
    id: "event_1",
    type,
    createdAt: "2026-04-14T00:00:00.000Z",
    sessionId: "session_1",
    worklineId: "workline_1",
    executorId: "executor_1",
    headId: "head_1",
    agentId: "agent_1",
    payload: type === "status.changed"
      ? {
          status: "running",
          detail: "执行中",
        }
      : {
          delta: "hi",
          text: "hi",
        },
  } as RuntimeEvent;
}

function createControllerStub(input?: {
  executeResult?: CommandResult;
  waitForExit?: Promise<void>;
  executeCommandImpl?: () => Promise<CommandResult>;
  submitInputImpl?: () => Promise<void>;
}) {
  const dispose = vi.fn(async () => {});
  const submitInput = vi.fn(async () => {
    await (input?.submitInputImpl?.() ?? Promise.resolve());
  });
  const executeCommand = vi.fn(async () => {
    if (input?.executeCommandImpl) {
      return input.executeCommandImpl();
    }
    return input?.executeResult ?? createCommandResult();
  });
  const waitForExit = vi.fn(async () => {
    await (input?.waitForExit ?? Promise.resolve());
  });
  const subscribeRuntimeEvents = vi.fn((handler: (event: RuntimeEvent) => void) => {
    handler(createRuntimeEvent("status.changed"));
    return vi.fn();
  });

  return {
    dispose,
    executeCommand,
    submitInput,
    subscribeRuntimeEvents,
    waitForExit,
  };
}

describe("runCli", () => {
  const stdoutWrite = vi.spyOn(process.stdout, "write");
  const consoleLog = vi.spyOn(console, "log");
  const consoleError = vi.spyOn(console, "error");

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    stdoutWrite.mockImplementation(() => true);
    consoleLog.mockImplementation(() => {});
    consoleError.mockImplementation(() => {});
    mockRender.mockReturnValue({
      waitUntilExit: vi.fn(async () => {}),
      unmount: vi.fn(),
    });
  });

  it("无参数时输出帮助", async () => {
    await runCli([]);

    expect(consoleLog).toHaveBeenCalledOnce();
    expect(String(consoleLog.mock.calls[0]?.[0])).toContain("QAgent CLI");
    expect(mockControllerCreate).not.toHaveBeenCalled();
  });

  it("解析错误时输出错误和帮助，并返回 exitCode 2", async () => {
    await runCli(["--cwd"]);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("--cwd"));
    expect(consoleLog).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(2);
  });

  it("普通命令会创建 cli controller、输出文本结果并释放资源", async () => {
    const controller = createControllerStub({
      executeResult: createCommandResult({
        messages: [
          {
            level: "info",
            title: "Work",
            text: "当前没有活跃工位",
          },
        ],
      }),
    });
    mockControllerCreate.mockResolvedValue(controller);

    await runCli(["work", "status"]);

    expect(mockControllerCreate).toHaveBeenCalledWith({
      cliOptions: {},
      clientLabel: "cli",
    });
    expect(controller.executeCommand).toHaveBeenCalledWith({
      domain: "work",
      action: "status",
    });
    expect(stdoutWrite).toHaveBeenCalledWith("当前没有活跃工位\n");
    expect(process.exitCode).toBe(0);
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("json 输出模式会输出格式化后的 JSON", async () => {
    const result = createCommandResult({
      code: "memory.list",
      payload: {
        items: ["reply-language"],
      },
    });
    const controller = createControllerStub({
      executeResult: result,
    });
    mockControllerCreate.mockResolvedValue(controller);

    await runCli(["--json", "memory", "list"]);

    expect(stdoutWrite).toHaveBeenCalledWith(
      `${JSON.stringify(result, null, 2)}\n`,
    );
  });

  it("stream 输出模式会先订阅运行时事件，再执行命令", async () => {
    const unsubscribe = vi.fn();
    const controller = createControllerStub();
    controller.subscribeRuntimeEvents.mockImplementation((handler) => {
      handler(createRuntimeEvent("status.changed"));
      return unsubscribe;
    });
    mockControllerCreate.mockResolvedValue(controller);

    await runCli(["--stream", "run", "你好"]);

    expect(controller.subscribeRuntimeEvents).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledWith(
      `${JSON.stringify(createRuntimeEvent("status.changed"))}\n`,
    );
    expect(controller.executeCommand).toHaveBeenCalledWith({
      domain: "run",
      prompt: "你好",
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("命令执行抛错时也会取消 stream 订阅并释放 controller，避免资源悬挂", async () => {
    const unsubscribe = vi.fn();
    const controller = createControllerStub({
      executeCommandImpl: async () => {
        throw new Error("backend crashed");
      },
    });
    controller.subscribeRuntimeEvents.mockImplementation(() => unsubscribe);
    mockControllerCreate.mockResolvedValue(controller);

    await expect(runCli(["--stream", "run", "你好"])).rejects.toThrow("backend crashed");

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("tui 模式会渲染 App，并在存在初始 prompt 时提交输入", async () => {
    const controller = createControllerStub();
    const waitUntilExit = vi.fn(async () => {});
    const unmount = vi.fn();
    mockControllerCreate.mockResolvedValue(controller);
    mockRender.mockReturnValue({
      waitUntilExit,
      unmount,
    });

    await runCli(["tui", "帮我总结当前项目"]);

    expect(mockControllerCreate).toHaveBeenCalledWith({
      cliOptions: {
        initialPrompt: "帮我总结当前项目",
      },
      clientLabel: "tui",
    });
    expect(mockRender).toHaveBeenCalledOnce();
    expect(controller.submitInput).toHaveBeenCalledWith("帮我总结当前项目");
    expect(waitUntilExit).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("TUI 在 app 提前退出时不会被 waitForExit 悬挂住", async () => {
    const waiting = createDeferred<void>();
    const controller = createControllerStub({
      waitForExit: waiting.promise,
    });
    const waitUntilExit = vi.fn(async () => {});
    const unmount = vi.fn();
    mockControllerCreate.mockResolvedValue(controller);
    mockRender.mockReturnValue({
      waitUntilExit,
      unmount,
    });

    await runCli(["tui"]);

    expect(controller.waitForExit).toHaveBeenCalledOnce();
    expect(waitUntilExit).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
    waiting.resolve();
  });

  it("TUI 在 controller 提前请求退出时不会等待 app 永远返回", async () => {
    const appExit = createDeferred<void>();
    const controller = createControllerStub();
    const waitUntilExit = vi.fn(async () => {
      await appExit.promise;
    });
    const unmount = vi.fn();
    mockControllerCreate.mockResolvedValue(controller);
    mockRender.mockReturnValue({
      waitUntilExit,
      unmount,
    });

    await runCli(["tui"]);

    expect(controller.waitForExit).toHaveBeenCalledOnce();
    expect(waitUntilExit).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
    appExit.resolve();
  });

  it("TUI 初始 prompt 发送失败时仍会执行 unmount 和 dispose", async () => {
    const controller = createControllerStub({
      submitInputImpl: async () => {
        throw new Error("submit failed");
      },
    });
    const waitUntilExit = vi.fn(async () => {});
    const unmount = vi.fn();
    mockControllerCreate.mockResolvedValue(controller);
    mockRender.mockReturnValue({
      waitUntilExit,
      unmount,
    });

    await expect(runCli(["tui", "帮我总结当前项目"])).rejects.toThrow("submit failed");

    expect(unmount).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("gateway status 在未启动时输出 stopped", async () => {
    mockGetGatewayStatus.mockResolvedValue({
      manifest: undefined,
    });

    await runCli(["gateway", "status"]);

    expect(stdoutWrite).toHaveBeenCalledWith("gateway: stopped\n");
  });

  it("gateway status 在 stale 时输出详情并返回非零 exitCode", async () => {
    mockGetGatewayStatus.mockResolvedValue({
      manifest: {
        pid: 1234,
        baseUrl: "http://127.0.0.1:3900",
        cwd: "/tmp/project",
        logPath: "/tmp/project/.agent/logs/gateway.log",
      },
      health: undefined,
    });

    await runCli(["gateway", "status"]);

    expect(stdoutWrite).toHaveBeenCalledWith(
      "gateway: stale\n"
      + "pid: 1234\n"
      + "url: http://127.0.0.1:3900\n"
      + "cwd: /tmp/project\n"
      + "log: /tmp/project/.agent/logs/gateway.log\n",
    );
    expect(process.exitCode).toBe(1);
  });

  it("edge status 在运行中时输出详情", async () => {
    mockGetEdgeStatus.mockResolvedValue({
      manifest: {
        pid: 4321,
        baseUrl: "http://127.0.0.1:4000",
        version: "0.1.0",
      },
      health: {
        ok: true,
      },
    });

    await runCli(["edge", "status"]);

    expect(stdoutWrite).toHaveBeenCalledWith(
      "edge: running\n"
      + "pid: 4321\n"
      + "url: http://127.0.0.1:4000\n"
      + "version: 0.1.0\n",
    );
    expect(process.exitCode).toBe(0);
  });
});
