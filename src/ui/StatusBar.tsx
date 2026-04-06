import { Box, Text } from "ink";

import type { AgentStatus } from "../runtime/index.js";

interface StatusBarProps {
  agentKind?: string;
  workingHeadId: string;
  workingHeadName?: string;
  sessionId: string;
  sessionRefLabel?: string;
  shellCwd: string;
  approvalMode: string;
  status: AgentStatus;
  skillCount: number;
  agentCount: number;
}

export function StatusBar({
  agentKind,
  workingHeadId,
  workingHeadName,
  sessionId,
  sessionRefLabel,
  shellCwd,
  approvalMode,
  status,
  skillCount,
  agentCount,
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
        agent={workingHeadName ?? "N/A"} ({workingHeadId || "N/A"}) | kind={agentKind ?? "N/A"} | session={sessionId || "N/A"} | status={status.mode} | detail={status.detail}
      </Text>
      <Text>
        ref={sessionRefLabel ?? "N/A"} | shell={shellCwd} | approval={approvalMode} | skills={skillCount} | agents={agentCount}
      </Text>
    </Box>
  );
}
