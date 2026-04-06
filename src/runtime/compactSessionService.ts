import type {
  ApprovalMode,
  LlmMessage,
  PromptProfile,
  RuntimeConfig,
  SessionSnapshot,
  SessionWorkingHead,
  ToolMode,
  UIMessage,
} from "../types.js";
import { createId } from "../utils/index.js";

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
    appendUiMessages(messages: UIMessage[]): Promise<void>;
    applyCompaction(input: {
      modelMessages: LlmMessage[];
      summary: string;
      metadata: Record<string, unknown>;
    }): Promise<void>;
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

export function groupMessagesForCompact(messages: LlmMessage[]): LlmMessage[][] {
  const groups: LlmMessage[][] = [];
  let current: LlmMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      groups.push(current);
      current = [message];
      continue;
    }
    current.push(message);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function estimateSingleMessageTokens(message: LlmMessage): number {
  const contentTokens = message.content.length / 4;
  if (message.role !== "assistant" || !message.toolCalls?.length) {
    return contentTokens;
  }
  const toolCallTokens = message.toolCalls.reduce((sum, toolCall) => {
    return sum + (toolCall.name.length + JSON.stringify(toolCall.input).length) / 4;
  }, 0);
  return contentTokens + toolCallTokens;
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  const rough = messages.reduce((sum, message) => {
    return sum + estimateSingleMessageTokens(message);
  }, 0);
  return Math.ceil(rough * (4 / 3));
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
    const grouped = groupMessagesForCompact(snapshot.modelMessages);
    const beforeTokens = estimateMessagesTokens(snapshot.modelMessages);
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

    const prefixMessages = prefixGroups.flat();
    const helper = await this.agentManager.spawnTaskAgent({
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
    });

    try {
      await this.agentManager.submitInputToAgent(
        helper.id,
        buildCompactUserPrompt({
          reason: input.reason,
          removedGroups: prefixGroups.length,
          keptGroups: tailGroups.length,
          beforeTokens,
        }),
        {
          activate: false,
          skipFetchMemoryHook: true,
        },
      );

      const helperSnapshot = this.agentManager.getRuntime(helper.id).getSnapshot();
      const rawSummary = helperSnapshot.modelMessages
        .slice()
        .reverse()
        .find((message) => {
          return message.role === "assistant" && message.content.trim().length > 0;
        })?.content;
      const summary = rawSummary ? parseCompactSummary(rawSummary) : undefined;
      if (!summary) {
        throw new Error("compact helper 未返回合法摘要。");
      }

      const compactedMessages = [
        buildSyntheticSummaryMessage(summary),
        ...tailGroups.flat(),
      ];
      const afterTokens = estimateMessagesTokens(compactedMessages);
      await runtime.applyCompaction({
        modelMessages: compactedMessages,
        summary,
        metadata: {
          reason: input.reason,
          beforeTokens,
          afterTokens,
          keptGroups: tailGroups.length,
          removedGroups: prefixGroups.length,
          summaryAgentId: helper.id,
        },
      });
      return {
        compacted: true,
        agentId: helper.id,
        beforeTokens,
        afterTokens,
        keptGroups: tailGroups.length,
        removedGroups: prefixGroups.length,
        summary,
      };
    } finally {
      await this.agentManager.cleanupCompletedAgent(helper.id);
    }
  }
}
