import { Box, Text } from "ink";

import type { UIMessage } from "../types.js";

interface MessageListProps {
  messages: UIMessage[];
  draftAssistantText: string;
  maxItems?: number;
  constrained?: boolean;
}

function roleColor(role: UIMessage["role"]): string {
  switch (role) {
    case "user":
      return "cyan";
    case "assistant":
      return "green";
    case "tool":
      return "yellow";
    case "error":
      return "red";
    case "info":
    default:
      return "blue";
  }
}

function roleLabel(role: UIMessage["role"]): string {
  switch (role) {
    case "user":
      return "USER";
    case "assistant":
      return "AGENT";
    case "tool":
      return "TOOL";
    case "error":
      return "ERROR";
    case "info":
    default:
      return "INFO";
  }
}

export function MessageList({
  messages,
  draftAssistantText,
  maxItems = 24,
  constrained = false,
}: MessageListProps) {
  const visibleMessages = messages.slice(-maxItems);

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      height={constrained ? "100%" : undefined}
      overflow={constrained ? "hidden" : undefined}
    >
      <Text color="cyan">Conversation</Text>
      <Box
        flexDirection="column"
        flexGrow={constrained ? 1 : undefined}
        justifyContent={constrained ? "flex-end" : undefined}
        overflow={constrained ? "hidden" : undefined}
      >
        {visibleMessages.map((message) => (
          <Box key={message.id} flexDirection="column" marginTop={1}>
            <Text color={roleColor(message.role)}>
              [{roleLabel(message.role)}]
              {message.title ? ` ${message.title}` : ""}
            </Text>
            <Text>{message.content}</Text>
          </Box>
        ))}
        {draftAssistantText ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="green">[AGENT][streaming]</Text>
            <Text>{draftAssistantText}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
