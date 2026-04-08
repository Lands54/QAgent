import type { CommandResult, UIMessage } from "../types.js";
import { formatCommandMessages, formatUiMessagesAsText } from "./common.js";
import { createId } from "../utils/index.js";

export function formatCommandResultText(result: CommandResult): string {
  const payload = result.payload as
    | {
        uiMessages?: ReadonlyArray<UIMessage>;
      }
    | undefined;
  const sections = [
    formatCommandMessages(result.messages),
    payload?.uiMessages ? formatUiMessagesAsText(payload.uiMessages) : "",
  ].filter((section) => section.trim().length > 0);

  return sections.join("\n\n");
}

export function formatCommandResultUiMessages(result: CommandResult): UIMessage[] {
  const commandMessages = result.messages.map((message) => ({
    id: createId("ui"),
    role: message.level === "error" ? "error" as const : "info" as const,
    content: message.text,
    createdAt: new Date().toISOString(),
    title: message.title,
  }));
  const payload = result.payload as
    | {
        uiMessages?: ReadonlyArray<UIMessage>;
      }
    | undefined;

  return [
    ...commandMessages,
    ...(payload?.uiMessages ? [...payload.uiMessages] : []),
  ];
}
