import { render } from "ink-testing-library";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyState, type AppState } from "../../src/runtime/appState.js";

const inputBoxHarness = vi.hoisted(() => ({
  latestProps: undefined as
    | undefined
    | {
        value: string;
        onSubmit: (value: string) => Promise<void> | void;
      },
}));

vi.mock("../../src/ui/InputBox.js", () => ({
  InputBox: (props: { value: string; onSubmit: (value: string) => Promise<void> | void }) => {
    inputBoxHarness.latestProps = props;
    return null;
  },
}));

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

describe("App submit behavior", () => {
  beforeEach(() => {
    inputBoxHarness.latestProps = undefined;
  });

  it("clears the input before awaiting a queued submission", async () => {
    const controller = new FakeController();
    let resolveSubmit: (() => void) | undefined;
    controller.submitInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    render(<App controller={controller as never} />);
    const submit = inputBoxHarness.latestProps?.onSubmit("queued prompt stays hidden");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.submitInput).toHaveBeenCalledWith("queued prompt stays hidden");
    expect(inputBoxHarness.latestProps?.value).toBe("");

    resolveSubmit?.();
    await submit;
  });
});
