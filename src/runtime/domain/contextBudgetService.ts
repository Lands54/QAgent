import type { LlmMessage, ToolCall } from "../../types.js";

function estimateToolCallTokens(toolCall: ToolCall): number {
  return (toolCall.name.length + JSON.stringify(toolCall.input).length) / 4;
}

function estimateSingleMessageTokens(message: LlmMessage): number {
  const contentTokens = message.content.length / 4;
  if (message.role !== "assistant" || !message.toolCalls?.length) {
    return contentTokens;
  }
  const toolCallTokens = message.toolCalls.reduce((sum, toolCall) => {
    return sum + estimateToolCallTokens(toolCall);
  }, 0);
  return contentTokens + toolCallTokens;
}

export function groupMessagesForCompact(
  messages: ReadonlyArray<LlmMessage>,
): LlmMessage[][] {
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

export function estimateMessagesTokens(
  messages: ReadonlyArray<LlmMessage>,
): number {
  const rough = messages.reduce((sum, message) => {
    return sum + estimateSingleMessageTokens(message);
  }, 0);
  return Math.ceil(rough * (4 / 3));
}

export interface ContextBudgetSummary {
  currentTokens: number;
  thresholdTokens: number;
  ratio: number;
  percent: number;
  shouldAutoCompact: boolean;
}

export class ContextBudgetService {
  public summarize(
    messages: ReadonlyArray<LlmMessage>,
    thresholdTokens: number,
  ): ContextBudgetSummary {
    const currentTokens = estimateMessagesTokens(messages);
    const ratio = thresholdTokens > 0 ? currentTokens / thresholdTokens : 0;

    return {
      currentTokens,
      thresholdTokens,
      ratio,
      percent: ratio * 100,
      shouldAutoCompact: thresholdTokens > 0 && currentTokens >= thresholdTokens,
    };
  }
}
