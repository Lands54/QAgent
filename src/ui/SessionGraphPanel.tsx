import { Box, Text } from "ink";

import type { SessionLogEntry } from "../types.js";
import { buildSessionGraphRows } from "./presentation/sessionGraph.js";

interface SessionGraphPanelProps {
  entries: SessionLogEntry[];
  activeNodeId?: string;
  activeRefLabel?: string;
  activeWorklineName?: string;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function SessionGraphPanel({
  entries,
  activeNodeId,
  activeRefLabel,
  activeWorklineName,
}: SessionGraphPanelProps) {
  const rows = buildSessionGraphRows(entries, {
    activeNodeId,
  });
  const metaLine = [
    activeWorklineName ? `workline=${activeWorklineName}` : undefined,
    activeRefLabel ? `ref=${truncate(activeRefLabel, 24)}` : undefined,
    activeNodeId ? `node=${truncate(activeNodeId, 18)}` : undefined,
    `recent=${entries.length}`,
  ]
    .filter(Boolean)
    .join(" | ");

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
    >
      <Text color="cyan">Session Graph</Text>
      <Text color="gray">{metaLine}</Text>
      {rows.map((row) => (
        <Text
          key={row.key}
          color={
            row.tone === "active"
              ? "green"
              : row.tone === "muted"
                ? "gray"
                : undefined
          }
        >
          {row.text}
        </Text>
      ))}
    </Box>
  );
}
