import { Box, Text } from "ink";

import type { ApprovalRequest } from "../types.js";

interface ApprovalModalProps {
  request: ApprovalRequest;
}

export function ApprovalModal({ request }: ApprovalModalProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      paddingY={0}
    >
      <Text color="yellow">待审批的 Shell Tool 调用</Text>
      <Text>风险级别: {request.riskLevel}</Text>
      <Text>{request.summary}</Text>
      <Text color="gray">按 y 批准，按 n 拒绝，按 Esc 也会拒绝。</Text>
    </Box>
  );
}
