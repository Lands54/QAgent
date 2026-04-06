import { Box, Text } from "ink";

import type { AgentStatus } from "../runtime/index.js";

interface StatusBarProps {
  sessionId: string;
  sessionRefLabel?: string;
  shellCwd: string;
  approvalMode: string;
  status: AgentStatus;
  skillCount: number;
}

export function StatusBar({
  sessionId,
  sessionRefLabel,
  shellCwd,
  approvalMode,
  status,
  skillCount,
}: StatusBarProps) {
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
      flexDirection="column"
    >
      <Text>
        session={sessionId || "N/A"} | status={status.mode} | detail={status.detail}
      </Text>
      <Text>
        ref={sessionRefLabel ?? "N/A"} | shell={shellCwd} | approval={approvalMode} | skills={skillCount}
      </Text>
    </Box>
  );
}
