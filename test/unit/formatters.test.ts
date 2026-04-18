import { describe, expect, it } from "vitest";

import { formatCommandResultText } from "../../src/command/formatters.js";
import type { CommandResult } from "../../src/types.js";

describe("formatCommandResultText", () => {
  it("在成功但无消息时提供可见的兜底输出", () => {
    const result: CommandResult = {
      status: "success",
      code: "run.completed",
      exitCode: 0,
      messages: [],
      payload: {
        uiMessages: [],
      },
    };

    expect(formatCommandResultText(result)).toBe(
      "命令执行完成，但没有可显示的输出。code=run.completed",
    );
  });
});
