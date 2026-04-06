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
      <Text>Agents</Text>
      {agents.map((agent) => (
        <Text key={agent.id}>
          {agent.id === activeAgentId ? "*" : " "} {agent.name} [{agent.id}] (
          {agent.kind}) | status={agent.status}
          {agent.helperType ? ` | helper=${agent.helperType}` : ""}
          {agent.pendingApproval ? " | pending=approval" : ""}
          {agent.sessionRefLabel ? ` | ref=${agent.sessionRefLabel}` : ""}
          {agent.detail ? ` | detail=${agent.detail}` : ""}
        </Text>
      ))}
    </Box>
  );
}
