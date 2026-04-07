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
  const statusColor =
    status.mode === "error"
      ? "red"
      : status.mode === "running"
        ? "green"
        : status.mode === "awaiting-approval"
          ? "yellow"
          : "gray";

  return (
    <Box
      borderStyle="round"
      borderColor={statusColor}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={statusColor}>
        Session Overview
      </Text>
      <Text>
        agent={workingHeadName ?? "N/A"} ({workingHeadId || "N/A"}) | kind={agentKind ?? "N/A"} | session={sessionId || "N/A"}
      </Text>
      <Text>
        status={status.mode} | detail={status.detail} | ref={sessionRefLabel ?? "N/A"}
      </Text>
      <Text>
        shell={shellCwd} | approval={approvalMode} | skills={skillCount} | agents={agentCount}
      </Text>
    </Box>
  );
}
