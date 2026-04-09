import { Box, Text } from "ink";

import type { AgentStatus } from "../runtime/index.js";

interface StatusBarProps {
  executorKind?: string;
  worklineId: string;
  worklineName?: string;
  sessionId: string;
  bookmarkLabel?: string;
  shellCwd: string;
  approvalMode: string;
  status: AgentStatus;
  skillCount: number;
  worklineCount: number;
}

export function StatusBar({
  executorKind,
  worklineId,
  worklineName,
  sessionId,
  bookmarkLabel,
  shellCwd,
  approvalMode,
  status,
  skillCount,
  worklineCount,
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
        Workline Overview
      </Text>
      <Text>
        workline={worklineName ?? "N/A"} ({worklineId || "N/A"}) | executor={executorKind ?? "N/A"} | session={sessionId || "N/A"}
      </Text>
      <Text>
        status={status.mode} | detail={status.detail} | bookmark={bookmarkLabel ?? "N/A"}
      </Text>
      <Text>
        shell={shellCwd} | approval={approvalMode} | skills={skillCount} | worklines={worklineCount}
      </Text>
    </Box>
  );
}
