import { describe, expect, it } from "vitest";

import {
  createConversationCompactedEvent,
  createConversationEntryAppendedEvent,
} from "../../src/session/index.js";
import type { ConversationEntry } from "../../src/types.js";

describe("sessionEvents", () => {
  it("会为 conversation.entry.appended 保存完整 entry 快照", () => {
    const entry: ConversationEntry = {
      id: "entry_1",
      kind: "user-input",
      createdAt: "2026-04-07T00:00:00.000Z",
      ui: {
        id: "ui_1",
        role: "user",
        content: "请继续整理 journal 设计",
        createdAt: "2026-04-07T00:00:00.000Z",
      },
      model: {
        id: "llm_1",
        role: "user",
        content: "请继续整理 journal 设计",
        createdAt: "2026-04-07T00:00:00.000Z",
      },
    };

    const event = createConversationEntryAppendedEvent({
      workingHeadId: "head_1",
      sessionId: "session_1",
      entry,
    });

    expect(event.type).toBe("conversation.entry.appended");
    expect(event.payload.entryKind).toBe("user-input");
    expect(event.payload.entry).toEqual(entry);
  });

  it("会为 conversation.compacted 保存 compact 元数据", () => {
    const event = createConversationCompactedEvent({
      workingHeadId: "head_1",
      sessionId: "session_1",
      reason: "manual",
      beforeTokens: 1024,
      afterTokens: 320,
      keptGroups: 2,
      removedGroups: 5,
      summaryAgentId: "head_helper",
      compactedEntryIds: ["entry_1", "entry_2"],
      summaryEntryId: "entry_summary",
    });

    expect(event.type).toBe("conversation.compacted");
    expect(event.payload).toEqual({
      reason: "manual",
      beforeTokens: 1024,
      afterTokens: 320,
      keptGroups: 2,
      removedGroups: 5,
      summaryAgentId: "head_helper",
      compactedEntryIds: ["entry_1", "entry_2"],
      summaryEntryId: "entry_summary",
    });
  });
});
