import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/context/promptAssembler.js";
import { createMemorySessionAssetProvider } from "../../src/memory/index.js";
import { AgentManager } from "../../src/runtime/agentManager.js";
import { SessionService } from "../../src/session/index.js";
import { ApprovalPolicy } from "../../src/tool/approvalPolicy.js";
import type {
  ModelClient,
  ModelTurnRequest,
  ModelTurnResult,
  RuntimeConfig,
  SessionEvent,
} from "../../src/types.js";

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function buildConfig(
  projectDir: string,
  overrides?: {
    runtime?: Partial<RuntimeConfig["runtime"]>;
  },
): RuntimeConfig {
  return {
    cwd: projectDir,
    resolvedPaths: {
      cwd: projectDir,
      homeDir: projectDir,
      globalAgentDir: path.join(projectDir, ".global"),
      projectRoot: projectDir,
      projectAgentDir: path.join(projectDir, ".agent"),
      globalConfigPath: path.join(projectDir, ".global", "config.json"),
      projectConfigPath: path.join(projectDir, ".agent", "config.json"),
      globalMemoryDir: path.join(projectDir, ".global", "memory"),
      projectMemoryDir: path.join(projectDir, ".agent", "memory"),
      globalSkillsDir: path.join(projectDir, ".global", "skills"),
      projectSkillsDir: path.join(projectDir, ".agent", "skills"),
      sessionRoot: path.join(projectDir, ".agent", "sessions"),
    },
    model: {
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
      temperature: 0,
      systemPrompt: "你是一个终端 Agent。",
    },
    runtime: {
      maxAgentSteps: 4,
      fetchMemoryMaxAgentSteps: 3,
      autoMemoryForkMaxAgentSteps: 4,
      shellCommandTimeoutMs: 10_000,
      maxToolOutputChars: 2_000,
      maxConversationSummaryMessages: 10,
      autoCompactThresholdTokens: 120_000,
      compactRecentKeepGroups: 1,
      ...overrides?.runtime,
    },
    tool: {
      approvalMode: "always",
      shellExecutable: "/bin/zsh",
    },
    cli: {},
  };
}

class JournalAwareModelClient implements ModelClient {
  public async runTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    if (request.systemPrompt.includes("compact-session 子任务")) {
      return {
        assistantText: [
          "1. 用户目标与约束",
          "保留当前任务目标与继续工作的边界。",
          "",
          "2. 关键决策与当前实现状态",
          "已经完成 typed journal 的主链路改造。",
          "",
          "3. 重要文件、命令与错误",
          "涉及 sessionEvents、agentRuntime 与 compact 写回。",
          "",
          "4. 待办与下一步",
          "继续基于摘要与最近原始上下文完成后续工作。",
        ].join("\n"),
        toolCalls: [],
        finishReason: "stop",
      };
    }

    return {
      assistantText: "已完成本轮处理",
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

async function createAgentManager(
  config: RuntimeConfig,
  modelClient: ModelClient,
): Promise<AgentManager> {
  const sessionService = new SessionService(config.resolvedPaths.sessionRoot, [
    createMemorySessionAssetProvider({
      projectMemoryDir: config.resolvedPaths.projectMemoryDir,
      globalMemoryDir: config.resolvedPaths.globalMemoryDir,
    }),
  ]);
  const agentManager = new AgentManager(
    config,
    modelClient,
    new PromptAssembler(),
    sessionService,
    new ApprovalPolicy("always"),
    () => [],
  );
  await agentManager.initialize({
    cwd: config.cwd,
    shellCwd: config.cwd,
    approvalMode: "always",
  });
  return agentManager;
}

async function readEvents(
  sessionRoot: string,
  headId: string,
): Promise<SessionEvent[]> {
  const raw = await readFile(
    path.join(sessionRoot, "__heads", headId, "events.ndjson"),
    "utf8",
  );
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
}

describe("session journal integration", () => {
  it("普通用户输入会写入 typed journal 事件", async () => {
    const projectDir = await makeTempDir("qagent-session-journal-input-");
    const config = buildConfig(projectDir);
    const agentManager = await createAgentManager(
      config,
      new JournalAwareModelClient(),
    );

    try {
      await agentManager.submitInputToActiveAgent("请继续整理事件日志方案");

      const runtime = agentManager.getActiveRuntime();
      const events = await readEvents(
        config.resolvedPaths.sessionRoot,
        runtime.headId,
      );
      expect(events.some((event) => {
        return (
          event.type === "conversation.entry.appended"
          && event.payload.entryKind === "user-input"
          && event.payload.entry.ui?.content === "请继续整理事件日志方案"
        );
      })).toBe(true);
      expect(events.some((event) => {
        return (
          event.type === "conversation.last_user_prompt.set"
          && event.payload.prompt === "请继续整理事件日志方案"
        );
      })).toBe(true);
      expect(events.some((event) => {
        return event.type === "agent.status.set";
      })).toBe(true);
    } finally {
      await agentManager.dispose();
    }
  });

  it("普通对话结束后仍会 autosave snapshot/events，但不会自动新增 checkpoint node", async () => {
    const projectDir = await makeTempDir("qagent-session-no-auto-checkpoint-");
    const config = buildConfig(projectDir);
    const agentManager = await createAgentManager(
      config,
      new JournalAwareModelClient(),
    );

    try {
      agentManager.setSaveMemoryHookEnabled(false);
      agentManager.setAutoCompactHookEnabled(false);
      const beforeLog = await agentManager.listSessionGraphLog();

      await agentManager.submitInputToActiveAgent("请继续整理 autosave 与 checkpoint 的边界");

      const runtime = agentManager.getActiveRuntime();
      const afterLog = await agentManager.listSessionGraphLog();
      const events = await readEvents(
        config.resolvedPaths.sessionRoot,
        runtime.headId,
      );

      expect(beforeLog).toHaveLength(1);
      expect(afterLog).toHaveLength(1);
      expect(afterLog[0]?.kind).toBe("root");
      expect(events.some((event) => {
        return (
          event.type === "conversation.entry.appended"
          && event.payload.entryKind === "assistant-turn"
        );
      })).toBe(true);
    } finally {
      await agentManager.dispose();
    }
  });

  it("退出前 dirty 的会话仍会补一个 checkpoint node", async () => {
    const projectDir = await makeTempDir("qagent-session-exit-checkpoint-");
    const config = buildConfig(projectDir);
    const agentManager = await createAgentManager(
      config,
      new JournalAwareModelClient(),
    );

    try {
      const runtime = agentManager.getActiveRuntime();
      await runtime.seedConversation({
        modelMessages: [
          {
            id: "assistant-1",
            role: "assistant",
            content: "尚未提交的退出前内容",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        lastUserPrompt: "退出前整理状态",
      });

      const beforeLog = await agentManager.listSessionGraphLog();
      await agentManager.flushCheckpointsOnExit();
      const afterLog = await agentManager.listSessionGraphLog();

      expect(beforeLog).toHaveLength(1);
      expect(afterLog).toHaveLength(2);
      expect(afterLog[0]?.kind).toBe("checkpoint");
    } finally {
      await agentManager.dispose();
    }
  });

  it("手动 commit 后可以通过 commit id 切回对应 snapshot", async () => {
    const projectDir = await makeTempDir("qagent-session-commit-switch-");
    const config = buildConfig(projectDir);
    const agentManager = await createAgentManager(
      config,
      new JournalAwareModelClient(),
    );

    try {
      const runtime = agentManager.getActiveRuntime();
      await runtime.seedConversation({
        modelMessages: [
          {
            id: "assistant-1",
            role: "assistant",
            content: "commit 前的上下文",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        lastUserPrompt: "先保存第一版",
      });

      const commit = await agentManager.commitSession("保存第一版");
      await runtime.seedConversation({
        modelMessages: [
          {
            id: "assistant-2",
            role: "assistant",
            content: "commit 之后的新上下文",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        lastUserPrompt: "继续推进第二版",
      });

      await agentManager.switchSessionRef(commit.id);
      const snapshot = agentManager.getActiveRuntime().getSnapshot();
      const commits = await agentManager.listSessionCommits();

      expect(snapshot.modelMessages.at(-1)?.content).toBe("commit 前的上下文");
      expect(commits.commits.some((item) => item.id === commit.id)).toBe(true);
    } finally {
      await agentManager.dispose();
    }
  });

  it("compact 后会追加 conversation.compacted，且旧 entry 原文仍保留在 appended journal 中", async () => {
    const projectDir = await makeTempDir("qagent-session-journal-compact-");
    const config = buildConfig(projectDir);
    const agentManager = await createAgentManager(
      config,
      new JournalAwareModelClient(),
    );

    try {
      await agentManager.submitInputToActiveAgent("第一轮：整理 typed journal 的事件语义");
      await agentManager.submitInputToActiveAgent("第二轮：补充 compact 与 append-only 的关系");

      const beforeCompactRuntime = agentManager.getActiveRuntime();
      const beforeEvents = await readEvents(
        config.resolvedPaths.sessionRoot,
        beforeCompactRuntime.headId,
      );
      const appendedBeforeCompact = beforeEvents.filter((event) => {
        return event.type === "conversation.entry.appended";
      });

      const result = await agentManager.compactSession();
      expect(result.compacted).toBe(true);

      const runtime = agentManager.getActiveRuntime();
      const events = await readEvents(
        config.resolvedPaths.sessionRoot,
        runtime.headId,
      );
      const compactEvent = events.find((event) => {
        return event.type === "conversation.compacted";
      });

      expect(compactEvent).toBeTruthy();
      if (!compactEvent || compactEvent.type !== "conversation.compacted") {
        return;
      }

      expect(compactEvent.payload.compactedEntryIds.length).toBeGreaterThan(0);
      expect(compactEvent.payload.summaryEntryId).toBeTruthy();
      expect(appendedBeforeCompact.some((event) => {
        return (
          event.type === "conversation.entry.appended"
          && event.payload.entry.ui?.content === "第一轮：整理 typed journal 的事件语义"
        );
      })).toBe(true);
      expect(
        compactEvent.payload.compactedEntryIds.every((entryId) => {
          return appendedBeforeCompact.some((event) => {
            return (
              event.type === "conversation.entry.appended"
              && event.payload.entry.id === entryId
            );
          });
        }),
      ).toBe(true);
    } finally {
      await agentManager.dispose();
    }
  });
});
