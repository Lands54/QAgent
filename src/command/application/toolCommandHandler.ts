import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { ToolCommandDeps } from "./commandDeps.js";
import {
  info,
  runtimeErrorResult,
  success,
  validationError,
} from "./commandResultFactory.js";

export class ToolCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "tool" }>> {
  public constructor(private readonly deps: ToolCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "tool" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      return success(
        "tool.status",
        [
          info(
            [
              `approvalMode: ${this.deps.getApprovalMode()}`,
              `shellCwd: ${this.deps.getShellCwd()}`,
            ].join("\n"),
          ),
        ],
      );
    }
    if (!request.mode) {
      return validationError("tool.confirm_usage", "用法：tool confirm <always|risky|never>");
    }
    await this.deps.setApprovalMode(request.mode);
    return success("tool.confirm_updated", [info(`approval mode 已切换为 ${request.mode}。`)]);
  }
}
