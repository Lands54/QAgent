import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { RunCommandDeps } from "./commandDeps.js";
import {
  approvalRequired,
  runtimeErrorResult,
  success,
  validationError,
} from "./commandResultFactory.js";

export class RunCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "run" }>> {
  public constructor(private readonly deps: RunCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "run" }>,
  ): Promise<CommandResult> {
    if (!request.prompt.trim()) {
      return validationError("run.prompt_required", "用法：run <prompt>");
    }
    const approvalHandlingMode = this.deps.getApprovalMode() === "never"
      ? undefined
      : "checkpoint";
    const result = await this.deps.runPrompt(request.prompt, {
      agentId: request.agentId,
      approvalMode: approvalHandlingMode,
      modelInputAppendix: request.modelInputAppendix,
    });
    if (result.settled === "approval_required" && result.checkpoint) {
      return approvalRequired(result.checkpoint, result.uiMessages);
    }
    if (result.settled === "error") {
      return runtimeErrorResult("run.executor_error", result.executor.detail, {
        executor: result.executor,
        uiMessages: result.uiMessages,
      });
    }
    if (result.settled === "interrupted") {
      return runtimeErrorResult("run.interrupted", result.executor.detail, {
        executor: result.executor,
        uiMessages: result.uiMessages,
      });
    }
    return success("run.completed", [], {
      executor: result.executor,
      uiMessages: result.uiMessages,
    });
  }
}
