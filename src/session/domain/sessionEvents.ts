import type {
  AgentStatusSetEvent,
  AgentStatusSetPayload,
  ConversationCompactedEvent,
  ConversationCompactedPayload,
  ConversationEntry,
  ConversationEntryAppendedEvent,
  ConversationLastUserPromptSetEvent,
  ConversationModelContextResetEvent,
  ConversationModelContextResetPayload,
  ConversationUiClearedEvent,
  RuntimeUiContextSetEvent,
  SessionCreatedEvent,
} from "../../types.js";
import { createId } from "../../utils/index.js";

interface SessionEventContext {
  workingHeadId: string;
  sessionId: string;
  timestamp?: string;
}

function buildEventEnvelope(input: SessionEventContext): Omit<
  SessionCreatedEvent,
  "type" | "payload"
> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    id: createId("event"),
    workingHeadId: input.workingHeadId,
    sessionId: input.sessionId,
    timestamp,
  };
}

export function createSessionCreatedEvent(input: SessionEventContext & {
  cwd: string;
  shellCwd: string;
}): SessionCreatedEvent {
  return {
    ...buildEventEnvelope(input),
    type: "session.created",
    payload: {
      cwd: input.cwd,
      shellCwd: input.shellCwd,
    },
  };
}

export function createConversationEntryAppendedEvent(
  input: SessionEventContext & {
    entry: ConversationEntry;
  },
): ConversationEntryAppendedEvent {
  return {
    ...buildEventEnvelope(input),
    type: "conversation.entry.appended",
    payload: {
      entryKind: input.entry.kind,
      entry: input.entry,
    },
  };
}

export function createConversationLastUserPromptSetEvent(
  input: SessionEventContext & {
    prompt: string;
  },
): ConversationLastUserPromptSetEvent {
  return {
    ...buildEventEnvelope(input),
    type: "conversation.last_user_prompt.set",
    payload: {
      prompt: input.prompt,
    },
  };
}

export function createConversationUiClearedEvent(
  input: SessionEventContext,
): ConversationUiClearedEvent {
  return {
    ...buildEventEnvelope(input),
    type: "conversation.ui.cleared",
    payload: {},
  };
}

export function createConversationModelContextResetEvent(
  input: SessionEventContext & ConversationModelContextResetPayload,
): ConversationModelContextResetEvent {
  return {
    ...buildEventEnvelope(input),
    type: "conversation.model_context.reset",
    payload: {
      resetEntryIds: [...input.resetEntryIds],
    },
  };
}

export function createRuntimeUiContextSetEvent(
  input: SessionEventContext & {
    enabled: boolean;
  },
): RuntimeUiContextSetEvent {
  return {
    ...buildEventEnvelope(input),
    type: "runtime.ui_context.set",
    payload: {
      enabled: input.enabled,
    },
  };
}

export function createAgentStatusSetEvent(
  input: SessionEventContext & AgentStatusSetPayload,
): AgentStatusSetEvent {
  return {
    ...buildEventEnvelope(input),
    type: "agent.status.set",
    payload: {
      mode: input.mode,
      detail: input.detail,
    },
  };
}

export function createConversationCompactedEvent(
  input: SessionEventContext & ConversationCompactedPayload,
): ConversationCompactedEvent {
  return {
    ...buildEventEnvelope(input),
    type: "conversation.compacted",
    payload: {
      reason: input.reason,
      beforeTokens: input.beforeTokens,
      afterTokens: input.afterTokens,
      keptGroups: input.keptGroups,
      removedGroups: input.removedGroups,
      summaryAgentId: input.summaryAgentId,
      compactedEntryIds: [...input.compactedEntryIds],
      summaryEntryId: input.summaryEntryId,
    },
  };
}
