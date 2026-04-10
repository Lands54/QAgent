import { Box, Text } from "ink";

import type { WorklineView } from "../types.js";

interface WorklineListProps {
  worklines: WorklineView[];
  activeWorklineId: string;
}

export function WorklineList({ worklines, activeWorklineId }: WorklineListProps) {
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
    >
      <Text color="cyan">Worklines · {worklines.length}</Text>
      {worklines.map((workline) => (
        <Box key={workline.id} flexDirection="column" marginTop={1}>
          <Text color={workline.id === activeWorklineId ? "green" : undefined}>
            {workline.id === activeWorklineId ? "●" : "○"} {workline.name} [{workline.id}]
          </Text>
          <Text color="gray">
            status={workline.status}
            {workline.pendingApproval ? " | pending=approval" : ""}
            {workline.queuedInputCount > 0 ? ` | queue=${workline.queuedInputCount}` : ""}
            {workline.attachmentLabel ? ` | bookmark=${workline.attachmentLabel}` : ""}
            {workline.writeLock ? ` | lock=${workline.writeLock}` : ""}
            {workline.detail ? ` | detail=${workline.detail}` : ""}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
