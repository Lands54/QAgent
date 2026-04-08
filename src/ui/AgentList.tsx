import { Box, Text } from "ink";

import type { AgentViewState } from "../types.js";

interface AgentListProps {
  agents: AgentViewState[];
  activeAgentId: string;
}

export function AgentList({ agents, activeAgentId }: AgentListProps) {
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
    >
      <Text color="cyan">Agents · {agents.length}</Text>
      {agents.map((agent) => (
        <Box key={agent.id} flexDirection="column" marginTop={1}>
          <Text color={agent.id === activeAgentId ? "green" : undefined}>
            {agent.id === activeAgentId ? "●" : "○"} {agent.name} [{agent.id}] ({agent.kind})
          </Text>
          <Text color="gray">
            status={agent.status}
            {agent.queuedInputCount > 0 ? ` | queue=${agent.queuedInputCount}` : ""}
            {agent.helperType ? ` | helper=${agent.helperType}` : ""}
            {agent.pendingApproval ? " | pending=approval" : ""}
            {agent.sessionRefLabel ? ` | ref=${agent.sessionRefLabel}` : ""}
            {agent.detail ? ` | detail=${agent.detail}` : ""}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
