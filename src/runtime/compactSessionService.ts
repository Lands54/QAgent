import { buildProjectedModelMessageEntries } from "../session/index.js";
import type {
  ApprovalMode,
  ConversationEntry,
  ConversationCompactedPayload,
  LlmMessage,
  PromptProfile,
  RuntimeConfig,
  SessionSnapshot,
  SessionWorkingHead,
  ToolMode,
  UIMessage,
} from "../types.js";
import { createId } from "../utils/index.js";
import { HelperAgentCoordinator } from "./application/helperAgentCoordinator.js";
import {
  estimateMessagesTokens,
} from "./domain/contextBudgetService.js";

export const COMPACT_SUMMARY_PREFIX = "[QAGENT_COMPACT_SUMMARY v1]";

export interface CompactSessionResult {
  compacted: boolean;
  agentId?: string;
  beforeTokens: number;
  afterTokens: number;
  keptGroups: number;
  removedGroups: number;
  summary?: string;
}

interface CompactSessionCoordinator {
  getBaseSystemPrompt(): string | undefined;
  getRuntime(agentId: string): {
    agentId: string;
    headId: string;
    promptProfile: PromptProfile;
    getHead(): SessionWorkingHead;
    getSnapshot(): SessionSnapshot;
    appendUiMessages(messages: ReadonlyArray<UIMessage>): Promise<void>;
    applyCompaction(input: {
      conversationEntries: ConversationEntry[];
      summary: string;
      event: ConversationCompactedPayload;
    }): Promise<void>;
    isUiContextEnabled(): boolean;
  };
  spawnTaskAgent(input: {
    name: string;
    sourceAgentId?: string;
    activate?: boolean;
    approvalMode?: ApprovalMode;
    promptProfile?: PromptProfile;
    toolMode?: ToolMode;
    autoMemoryFork?: boolean;
    retainOnCompletion?: boolean;
    seedModelMessages?: LlmMessage[];
    seedUiMessages?: UIMessage[];
    lastUserPrompt?: string;
    buildRuntimeOverrides?: (head: SessionWorkingHead) => {
      promptProfile?: PromptProfile;
      toolMode?: ToolMode;
      systemPrompt?: string;
      maxAgentSteps?: number;
      environment?: Record<string, string>;
    };
  }): Promise<{ id: string }>;
  submitInputToAgent(
    agentId: string,
    input: string,
    options?: {
      activate?: boolean;
      skipFetchMemoryHook?: boolean;
    },
  ): Promise<void>;
  cleanupCompletedAgent(agentId: string): Promise<void>;
  shouldAutoCleanupHelperAgent(): boolean;
}

export interface CompactSessionInput {
  targetAgentId: string;
  reason: "manual" | "auto";
  force: boolean;
}

function buildCompactSystemPrompt(basePrompt: string | undefined): string {
  return [
    basePrompt ?? "",
    "你正在执行 compact-session 子任务。",
    "你的唯一目标是把上文已有对话压缩成一份可继续工作的结构化摘要。",
    "禁止调用任何工具；你已经拿到了全部需要压缩的历史上下文。",
    "你的输出必须是纯文本，严格使用以下 4 个编号章节：",
    "1. 用户目标与约束",
    "2. 关键决策与当前实现状态",
    "3. 重要文件、命令与错误",
    "4. 待办与下一步",
    "每个章节都必须出现，内容应尽量具体、可执行，并保留关键文件名、命令、错误信息和未完成事项。",
    "不要输出代码块，不要输出 XML/JSON，不要与用户寒暄，也不要解释你正在做 compact。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCompactUserPrompt(input: {
  reason: CompactSessionInput["reason"];
  removedGroups: number;
  keptGroups: number;
  beforeTokens: number;
}): string {
  return [
    `当前时间：${new Date().toISOString()}`,
    `compact 触发原因：${input.reason === "manual" ? "manual" : "auto"}`,
    `将被摘要的历史分组数：${input.removedGroups}`,
    `压缩后保留的原始分组数：${input.keptGroups}`,
    `压缩前估算 tokens：${input.beforeTokens}`,
    "请基于前面的历史消息，直接输出 4 个编号章节的摘要。",
  ].join("\n");
}

function buildSyntheticSummaryMessage(summary: string): LlmMessage {
  return {
    id: createId("llm"),
    role: "user",
    content: `${COMPACT_SUMMARY_PREFIX}\n\n${summary.trim()}`,
    createdAt: new Date().toISOString(),
  };
}

function parseCompactSummary(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  const requiredSections = ["1.", "2.", "3.", "4."];
  return requiredSections.every((section) => trimmed.includes(section))
    ? trimmed
    : undefined;
}

export class CompactSessionService {
  public constructor(
    private readonly agentManager: CompactSessionCoordinator,
    private readonly config: RuntimeConfig,
  ) {}

  public async run(input: CompactSessionInput): Promise<CompactSessionResult> {
    const runtime = this.agentManager.getRuntime(input.targetAgentId);
    const snapshot = runtime.getSnapshot();
    const projectedEntries = buildProjectedModelMessageEntries(
      snapshot,
      runtime.isUiContextEnabled(),
    );
    const grouped = groupProjectedModelEntries(projectedEntries);
    const beforeTokens = estimateMessagesTokens(
      projectedEntries.map((entry) => entry.message),
    );
    const keepGroups = Math.max(1, this.config.runtime.compactRecentKeepGroups);
    if (!input.force && beforeTokens < this.config.runtime.autoCompactThresholdTokens) {
      return {
        compacted: false,
        beforeTokens,
        afterTokens: beforeTokens,
        keptGroups: Math.min(grouped.length, keepGroups),
        removedGroups: 0,
      };
    }

    const prefixGroups = grouped.slice(0, Math.max(0, grouped.length - keepGroups));
    const tailGroups = grouped.slice(prefixGroups.length);
    if (prefixGroups.length === 0) {
      return {
        compacted: false,
        beforeTokens,
        afterTokens: beforeTokens,
        keptGroups: tailGroups.length,
        removedGroups: 0,
      };
    }

    const prefixMessages = prefixGroups.flatMap((group) => {
      return group.map((entry) => entry.message);
    });
    const helperCoordinator = new HelperAgentCoordinator(this.agentManager);
    const { agentId, result: rawSummary } = await helperCoordinator.run({
      name: `compact-session-${Date.now()}`,
      sourceAgentId: runtime.agentId,
      activate: false,
      approvalMode: "never",
      promptProfile: "compact-session",
      toolMode: "none",
      autoMemoryFork: false,
      retainOnCompletion: false,
      seedModelMessages: prefixMessages,
      seedUiMessages: [],
      buildRuntimeOverrides: () => ({
        promptProfile: "compact-session",
        toolMode: "none",
        systemPrompt: buildCompactSystemPrompt(
          this.agentManager.getBaseSystemPrompt(),
        ),
        maxAgentSteps: 1,
      }),
      buildPrompt: () =>
        buildCompactUserPrompt({
          reason: input.reason,
          removedGroups: prefixGroups.length,
          keptGroups: tailGroups.length,
          beforeTokens,
        }),
      submitOptions: {
        activate: false,
        skipFetchMemoryHook: true,
      },
      readResult: (helperRuntime) => {
        return helperRuntime
          .getSnapshot()
          .modelMessages
          .slice()
          .reverse()
          .find((message) => {
            return message.role === "assistant" && message.content.trim().length > 0;
          })?.content;
      },
    });

    const summary = rawSummary ? parseCompactSummary(rawSummary) : undefined;
    if (!summary) {
      throw new Error("compact helper 未返回合法摘要。");
    }

    const prefixEntryIndexes = new Set(
      prefixGroups.flatMap((group) => group.map((entry) => entry.entryIndex)),
    );
    const firstTailEntryIndex = tailGroups[0]?.[0]?.entryIndex;
    const summaryEntry = createCompactSummaryEntry(summary);
    const compactedEntries = snapshot.conversationEntries.map((entry, entryIndex) => {
      if (!prefixEntryIndexes.has(entryIndex)) {
        return entry;
      }
      return {
        ...entry,
        model: undefined,
        modelMirror: undefined,
      } satisfies ConversationEntry;
    });
    const summaryInsertIndex = firstTailEntryIndex ?? compactedEntries.length;
    compactedEntries.splice(summaryInsertIndex, 0, summaryEntry);
    const afterTokens = estimateMessagesTokens([
      summaryEntry.model as LlmMessage,
      ...tailGroups.flatMap((group) => group.map((entry) => entry.message)),
    ]);
    const compactedEntryIds = snapshot.conversationEntries
      .filter((_entry, entryIndex) => prefixEntryIndexes.has(entryIndex))
      .map((entry) => entry.id);
    await runtime.applyCompaction({
      conversationEntries: compactedEntries,
      summary,
      event: {
        reason: input.reason,
        beforeTokens,
        afterTokens,
        keptGroups: tailGroups.length,
        removedGroups: prefixGroups.length,
        summaryAgentId: agentId,
        compactedEntryIds,
        summaryEntryId: summaryEntry.id,
      },
    });
    return {
      compacted: true,
      agentId,
      beforeTokens,
      afterTokens,
      keptGroups: tailGroups.length,
      removedGroups: prefixGroups.length,
      summary,
    };
  }
}

function createCompactSummaryEntry(summary: string): ConversationEntry {
  return {
    id: createId("entry"),
    kind: "compact-summary",
    createdAt: new Date().toISOString(),
    model: buildSyntheticSummaryMessage(summary),
  };
}

function groupProjectedModelEntries(
  entries: Array<{
    entryIndex: number;
    message: LlmMessage;
  }>,
): Array<
  Array<{
    entryIndex: number;
    message: LlmMessage;
  }>
> {
  const groups: Array<
    Array<{
      entryIndex: number;
      message: LlmMessage;
    }>
  > = [];
  let current: Array<{
    entryIndex: number;
    message: LlmMessage;
  }> = [];

  for (const entry of entries) {
    if (entry.message.role === "user" && current.length > 0) {
      groups.push(current);
      current = [entry];
      continue;
    }
    current.push(entry);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}
