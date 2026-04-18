import {
  createConversationCompactedEvent,
  createConversationEntryAppendedEvent,
  createConversationModelContextResetEvent,
  createConversationUiClearedEvent,
  createRuntimeUiContextSetEvent,
  createConversationEntry,
  projectSnapshotConversationEntries,
  replaceConversationEntries,
  resetConversationModelContext,
  appendConversationEntry,
} from "../../session/index.js";
import type {
  AgentLifecycleStatus,
  ConversationCompactedPayload,
  ConversationEntry,
  ConversationEntryKind,
  LlmMessage,
  SessionEvent,
  SessionSnapshot,
  SessionWorkingHead,
  UIMessage,
} from "../../types.js";
import { createId } from "../../utils/index.js";
import type { RuntimeSessionPort } from "./runtimeSessionPort.js";

export function mapLifecycleStatusToHeadStatus(
  status: AgentLifecycleStatus,
): SessionWorkingHead["status"] {
  if (status === "booting" || status === "completed") {
    return "idle";
  }
  if (status === "closed") {
    return "closed";
  }
  return status;
}

function buildUiMirrorMessage(
  message: UIMessage,
  input?: {
    prefix?: string;
    role?: Exclude<LlmMessage["role"], "tool">;
  },
): LlmMessage {
  const prefix =
    input?.prefix
    ?? (message.role === "info"
      ? "[UI结果][INFO]"
      : message.role === "error"
        ? "[UI结果][ERROR]"
        : message.role === "tool"
          ? "[UI消息][TOOL]"
          : message.role === "assistant"
            ? "[UI消息][ASSISTANT]"
            : "[UI消息][USER]");
  return {
    id: createId("llm"),
    role:
      input?.role
      ?? (message.role === "user" ? "user" : "assistant"),
    content: `${prefix} ${message.content}`,
    createdAt: message.createdAt,
  };
}

function mapUiMessageToConversationKind(
  message: UIMessage,
  defaultKind: ConversationEntryKind = "ui-result",
): ConversationEntryKind {
  if (message.role === "info") {
    return "system-info";
  }
  if (message.role === "error") {
    return "system-error";
  }
  return defaultKind;
}

interface RuntimeConversationProjectorDeps {
  headId: string;
  sessionId: string;
  getHead(): SessionWorkingHead;
  setHead(head: SessionWorkingHead): void;
  getSnapshot(): SessionSnapshot;
  setSnapshot(snapshot: SessionSnapshot): void;
  getShellCwd(): string;
  isUiContextEnabled(): boolean;
  sessionService: RuntimeSessionPort;
  refreshSessionState(): Promise<void>;
  getLifecycleStatus(): AgentLifecycleStatus;
  onStateChanged(): void;
}

export class RuntimeConversationProjector {
  public constructor(private readonly deps: RuntimeConversationProjectorDeps) {}

  public async seedConversation(input: {
    modelMessages?: LlmMessage[];
    uiMessages?: UIMessage[];
    lastUserPrompt?: string;
  }): Promise<void> {
    let nextSnapshot = this.deps.getSnapshot();
    if (input.modelMessages) {
      nextSnapshot = {
        ...nextSnapshot,
        conversationEntries: [],
        modelMessages: [...input.modelMessages],
      };
    }
    if (input.uiMessages) {
      nextSnapshot = {
        ...nextSnapshot,
        conversationEntries: [],
        uiMessages: [...input.uiMessages],
      };
    }
    if (input.lastUserPrompt !== undefined) {
      nextSnapshot = {
        ...nextSnapshot,
        lastUserPrompt: input.lastUserPrompt,
      };
    }
    this.deps.setSnapshot(projectSnapshotConversationEntries(
      {
        ...nextSnapshot,
        updatedAt: new Date().toISOString(),
      },
      this.deps.isUiContextEnabled(),
    ));
    await this.persistSnapshot();
    this.deps.onStateChanged();
  }

  public async setUiContextEnabled(enabled: boolean): Promise<void> {
    this.deps.setHead(await this.deps.sessionService.updateHeadRuntimeState(
      this.deps.headId,
      {
        uiContextEnabled: enabled,
      },
    ));
    this.deps.setSnapshot(projectSnapshotConversationEntries(
      this.deps.getSnapshot(),
      enabled,
    ));
    await this.persistEvent(
      createRuntimeUiContextSetEvent({
        workingHeadId: this.deps.headId,
        sessionId: this.deps.sessionId,
        enabled,
      }),
    );
    await this.persistSnapshot();
    await this.deps.refreshSessionState();
    this.deps.onStateChanged();
  }

  public async recordSlashCommand(
    command: string,
    messages: ReadonlyArray<UIMessage>,
    input?: {
      includeInModelContext?: boolean;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const includeInModelContext = input?.includeInModelContext ?? true;
    await this.appendConversationEntry(
      createConversationEntry({
        kind: "ui-command",
        createdAt: now,
        ui: {
          id: createId("ui"),
          role: "user",
          content: command,
          createdAt: now,
        },
        modelMirror: includeInModelContext
          ? {
              id: createId("llm"),
              role: "user",
              content: `[UI命令] ${command}`,
              createdAt: now,
            }
          : undefined,
      }),
    );
    for (const message of messages) {
      await this.appendUiOnlyMessage(message, {
        includeInModelContext,
      });
    }
  }

  public async clearUiMessages(): Promise<void> {
    this.deps.setSnapshot(projectSnapshotConversationEntries(
      {
        ...this.deps.getSnapshot(),
        uiClearedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      this.deps.isUiContextEnabled(),
    ));
    await this.persistEvent(
      createConversationUiClearedEvent({
        workingHeadId: this.deps.headId,
        sessionId: this.deps.sessionId,
      }),
    );
    await this.persistSnapshot();
    this.deps.onStateChanged();
  }

  public async resetModelContext(): Promise<{
    resetEntryCount: number;
  }> {
    const result = resetConversationModelContext(
      this.deps.getSnapshot(),
      this.deps.isUiContextEnabled(),
    );
    this.deps.setSnapshot(result.snapshot);
    await this.persistEvent(
      createConversationModelContextResetEvent({
        workingHeadId: this.deps.headId,
        sessionId: this.deps.sessionId,
        resetEntryIds: result.resetEntryIds,
      }),
    );
    await this.persistSnapshot();
    this.deps.onStateChanged();
    return {
      resetEntryCount: result.resetEntryIds.length,
    };
  }

  public async appendUiMessages(
    messages: ReadonlyArray<UIMessage>,
  ): Promise<void> {
    for (const message of messages) {
      await this.appendUiOnlyMessage(message);
    }
  }

  public async applyCompaction(input: {
    conversationEntries: ConversationEntry[];
    summary: string;
    event: ConversationCompactedPayload;
  }): Promise<void> {
    this.deps.setSnapshot(replaceConversationEntries(
      this.deps.getSnapshot(),
      input.conversationEntries,
      this.deps.isUiContextEnabled(),
    ));
    this.deps.setSnapshot({
      ...this.deps.getSnapshot(),
      lastRunSummary: input.summary,
      updatedAt: new Date().toISOString(),
    });
    await this.persistEvent(
      createConversationCompactedEvent({
        workingHeadId: this.deps.headId,
        sessionId: this.deps.sessionId,
        ...input.event,
      }),
    );
    await this.persistSnapshot();
    await this.deps.sessionService.flushCompactSnapshot(this.deps.getSnapshot());
    await this.deps.refreshSessionState();
    this.deps.onStateChanged();
  }

  public async appendUiOnlyMessage(
    message: UIMessage,
    input?: {
      kind?: ConversationEntryKind;
      mirrorRole?: Exclude<LlmMessage["role"], "tool">;
      mirrorPrefix?: string;
      includeInModelContext?: boolean;
    },
  ): Promise<void> {
    const includeInModelContext = input?.includeInModelContext ?? true;
    await this.appendConversationEntry(
      createConversationEntry({
        kind:
          input?.kind ?? mapUiMessageToConversationKind(message, "ui-result"),
        createdAt: message.createdAt,
        ui: message,
        modelMirror: includeInModelContext
          ? buildUiMirrorMessage(message, {
              role: input?.mirrorRole,
              prefix: input?.mirrorPrefix,
            })
          : undefined,
      }),
    );
  }

  public async appendConversationEntry(
    entry: ConversationEntry,
  ): Promise<void> {
    this.deps.setSnapshot(appendConversationEntry(
      this.deps.getSnapshot(),
      entry,
      this.deps.isUiContextEnabled(),
    ));
    await this.persistEvent(
      createConversationEntryAppendedEvent({
        workingHeadId: this.deps.headId,
        sessionId: this.deps.sessionId,
        entry,
      }),
    );
    await this.persistSnapshot();
    this.deps.onStateChanged();
  }

  public async persistEvent(event: SessionEvent): Promise<void> {
    await this.deps.sessionService.persistWorkingEvent(event);
  }

  public async persistSnapshot(): Promise<void> {
    this.deps.setSnapshot({
      ...this.deps.getSnapshot(),
      workingHeadId: this.deps.headId,
      sessionId: this.deps.getHead().sessionId,
      shellCwd: this.deps.getShellCwd(),
      updatedAt: new Date().toISOString(),
    });
    await this.deps.sessionService.persistWorkingSnapshot(
      this.deps.getSnapshot(),
      mapLifecycleStatusToHeadStatus(this.deps.getLifecycleStatus()),
    );
  }
}
