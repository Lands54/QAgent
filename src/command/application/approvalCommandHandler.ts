import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { ApprovalCommandDeps } from "./commandDeps.js";
import {
  approvalRequired,
  info,
  runtimeErrorResult,
  success,
} from "./commandResultFactory.js";

export class ApprovalCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "approval" }>> {
  public constructor(private readonly deps: ApprovalCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "approval" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const checkpoint = await this.deps.getPendingApproval({
        checkpointId: request.checkpointId,
        agentId: request.agentId,
        headId: request.headId,
      });
      return success(
        "approval.status",
        [
          checkpoint
            ? info(
                [
                  `checkpoint: ${checkpoint.checkpointId}`,
                  `executor: ${checkpoint.executorId}`,
                  `workline: ${checkpoint.worklineId}`,
                  `session: ${checkpoint.sessionId}`,
                  `tool: ${checkpoint.toolCall.input.command}`,
                  `request: ${checkpoint.approvalRequest.id}`,
                ].join("\n"),
              )
            : info("当前没有待审批请求。"),
        ],
        {
          checkpoint,
        },
      );
    }

    const result = await this.deps.resolvePendingApproval(
      request.action === "approve",
      {
        checkpointId: request.checkpointId,
        agentId: request.agentId,
        headId: request.headId,
      },
    );
    if (result.settled === "approval_required" && result.checkpoint) {
      return approvalRequired(result.checkpoint, result.uiMessages);
    }
    if (result.settled === "error") {
      return runtimeErrorResult("approval.resume_error", result.executor.detail, {
        executor: result.executor,
        uiMessages: result.uiMessages,
      });
    }
    if (result.settled === "interrupted") {
      return runtimeErrorResult("approval.resume_interrupted", result.executor.detail, {
        executor: result.executor,
        uiMessages: result.uiMessages,
      });
    }
    return success(
      request.action === "approve" ? "approval.approved" : "approval.rejected",
      [
        info(request.action === "approve" ? "已批准并继续执行。" : "已拒绝并继续执行。"),
      ],
      {
        executor: result.executor,
        uiMessages: result.uiMessages,
      },
    );
  }
}
