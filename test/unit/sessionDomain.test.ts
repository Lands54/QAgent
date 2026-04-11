import { describe, expect, it } from "vitest";

import {
  normalizeSessionSnapshot,
  projectSnapshotConversationEntries,
  resetConversationModelContext,
} from "../../src/session/domain/sessionDomain.js";
import type { SessionSnapshot } from "../../src/types.js";

describe("sessionDomain conversation projection", () => {
  it("会按 ui-context 开关决定是否把 UI-only 镜像投影到 modelMessages", () => {
    const snapshot: SessionSnapshot = {
      workingHeadId: "head_main",
      sessionId: "session_main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
      conversationEntries: [
        {
          id: "entry_user",
          kind: "user-input",
          createdAt: "2026-01-01T00:00:01.000Z",
          ui: {
            id: "ui_user",
            role: "user",
            content: "用户问题",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          model: {
            id: "llm_user",
            role: "user",
            content: "用户问题",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        },
        {
          id: "entry_ui",
          kind: "ui-result",
          createdAt: "2026-01-01T00:00:02.000Z",
          ui: {
            id: "ui_info",
            role: "info",
            content: "命令执行完成",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          modelMirror: {
            id: "llm_info",
            role: "assistant",
            content: "[UI结果][INFO] 命令执行完成",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        },
      ],
      uiMessages: [],
      modelMessages: [],
      lastUserPrompt: "用户问题",
    };

    const projectedOff = projectSnapshotConversationEntries(snapshot, false);
    const projectedOn = projectSnapshotConversationEntries(snapshot, true);

    expect(projectedOff.uiMessages).toHaveLength(2);
    expect(projectedOff.modelMessages).toHaveLength(1);
    expect(projectedOn.modelMessages).toHaveLength(2);
    expect(projectedOn.modelMessages[1]?.content).toContain("[UI结果][INFO]");
  });

  it("会把旧 snapshot 的 ui/model 双轨迁移成统一时间线", () => {
    const migrated = normalizeSessionSnapshot(
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
        cwd: "/tmp/project",
        shellCwd: "/tmp/project",
        approvalMode: "always",
        uiMessages: [
          {
            id: "ui_user",
            role: "user",
            content: "你好",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: "ui_info",
            role: "info",
            content: "辅助提示",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        ],
        modelMessages: [
          {
            id: "llm_user",
            role: "user",
            content: "你好",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      },
      {
        headId: "head_main",
        sessionId: "session_main",
        fallbackTime: "2026-01-01T00:00:00.000Z",
        uiContextEnabled: true,
      },
    );

    expect(migrated.conversationEntries).toHaveLength(2);
    expect(migrated.uiMessages).toHaveLength(2);
    expect(migrated.modelMessages).toHaveLength(2);
    expect(migrated.modelMessages[1]?.content).toContain("[UI结果][INFO]");
  });

  it("重置模型上下文时保留 UI 时间线并清空模型投影", () => {
    const snapshot: SessionSnapshot = {
      workingHeadId: "head_main",
      sessionId: "session_main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
      cwd: "/tmp/project",
      shellCwd: "/tmp/project",
      approvalMode: "always",
      conversationEntries: [
        {
          id: "entry_user",
          kind: "user-input",
          createdAt: "2026-01-01T00:00:01.000Z",
          ui: {
            id: "ui_user",
            role: "user",
            content: "用户问题",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          model: {
            id: "llm_user",
            role: "user",
            content: "当前时间：2026-01-01T00:00:01.000Z\n\n用户问题",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        },
        {
          id: "entry_info",
          kind: "ui-result",
          createdAt: "2026-01-01T00:00:02.000Z",
          ui: {
            id: "ui_info",
            role: "info",
            content: "辅助提示",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          modelMirror: {
            id: "llm_info",
            role: "assistant",
            content: "[UI结果][INFO] 辅助提示",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        },
      ],
      uiMessages: [],
      modelMessages: [],
      lastUserPrompt: "用户问题",
      lastRunSummary: "上一轮摘要",
    };

    const result = resetConversationModelContext(snapshot, true);

    expect(result.resetEntryIds).toEqual(["entry_user", "entry_info"]);
    expect(result.snapshot.uiMessages).toHaveLength(2);
    expect(result.snapshot.modelMessages).toEqual([]);
    expect(result.snapshot.lastUserPrompt).toBeUndefined();
    expect(result.snapshot.lastRunSummary).toBeUndefined();
    expect(result.snapshot.conversationEntries[0]?.ui?.content).toBe("用户问题");
    expect(result.snapshot.conversationEntries[0]?.model).toBeUndefined();
    expect(result.snapshot.conversationEntries[1]?.modelMirror).toBeUndefined();
  });
});
