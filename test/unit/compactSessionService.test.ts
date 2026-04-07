import { describe, expect, it } from "vitest";

import {
  estimateMessagesTokens,
  groupMessagesForCompact,
} from "../../src/runtime/domain/contextBudgetService.js";
import type { LlmMessage } from "../../src/types.js";

function message(
  input: Omit<LlmMessage, "createdAt">,
): LlmMessage {
  return {
    ...input,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("compactSessionService", () => {
  it("会按完整 user turn 分组，不会把 tool 流程从中间切开", () => {
    const messages: LlmMessage[] = [
      message({
        id: "user-1",
        role: "user",
        content: "任务 1",
      }),
      message({
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            name: "shell",
            input: { command: "pwd" },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      message({
        id: "tool-message-1",
        role: "tool",
        name: "shell",
        toolCallId: "tool-1",
        content: "/tmp/project",
      }),
      message({
        id: "assistant-2",
        role: "assistant",
        content: "任务 1 完成",
      }),
      message({
        id: "user-2",
        role: "user",
        content: "任务 2",
      }),
      message({
        id: "assistant-3",
        role: "assistant",
        content: "任务 2 完成",
      }),
    ];

    const groups = groupMessagesForCompact(messages);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((item) => item.id)).toEqual([
      "user-1",
      "assistant-1",
      "tool-message-1",
      "assistant-2",
    ]);
    expect(groups[1]?.map((item) => item.id)).toEqual([
      "user-2",
      "assistant-3",
    ]);
  });

  it("会按文本与 tool call JSON 粗略估算 token", () => {
    const toolInput = { command: "pwd" };
    const messages: LlmMessage[] = [
      message({
        id: "user-1",
        role: "user",
        content: "12345678",
      }),
      message({
        id: "assistant-1",
        role: "assistant",
        content: "done",
        toolCalls: [
          {
            id: "tool-1",
            name: "shell",
            input: toolInput,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      message({
        id: "tool-message-1",
        role: "tool",
        name: "shell",
        toolCallId: "tool-1",
        content: "/tmp/project",
      }),
    ];

    const expected = Math.ceil(
      (
        (8 / 4)
        + (4 / 4)
        + (("shell".length + JSON.stringify(toolInput).length) / 4)
        + ("/tmp/project".length / 4)
      ) * (4 / 3),
    );

    expect(estimateMessagesTokens(messages)).toBe(expected);
  });
});
