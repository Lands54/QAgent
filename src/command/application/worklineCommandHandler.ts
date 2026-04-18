import {
  formatWorkline,
} from "../common.js";
import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { WorklineCommandDeps } from "./commandDeps.js";
import {
  info,
  runtimeErrorResult,
  success,
  validationError,
} from "./commandResultFactory.js";

type WorklineCommandRequest =
  | Extract<CommandRequest, { domain: "workline" }>
  | Extract<CommandRequest, { domain: "work" }>;

export class WorklineCommandHandler implements CommandHandler<WorklineCommandRequest> {
  public constructor(private readonly deps: WorklineCommandDeps) {}

  public async handle(
    request: WorklineCommandRequest,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const workline = await this.deps.getWorklineStatus(request.worklineId);
      return success("workline.status", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "list") {
      const worklines = await this.deps.listWorklines();
      return success(
        "workline.list",
        [
          info(
            worklines.worklines.length === 0
              ? "当前没有工位。"
              : worklines.worklines.map((workline) => formatWorkline(workline)).join("\n\n"),
          ),
        ],
        worklines,
      );
    }
    if (request.action === "new") {
      if (!request.name) {
        return validationError("workline.new_usage", "用法：workline new <name>");
      }
      const workline = await this.deps.createWorkline(request.name);
      return success("workline.created", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "switch") {
      if (!request.worklineId) {
        return validationError("workline.switch_usage", "用法：workline switch <worklineId|name>");
      }
      const workline = await this.deps.switchWorkline(request.worklineId);
      return success("workline.switched", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "next" || request.action === "prev") {
      const workline = await this.deps.switchWorklineRelative(request.action === "next" ? 1 : -1);
      return success("workline.switched", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "close") {
      if (!request.worklineId) {
        return validationError("workline.close_usage", "用法：workline close <worklineId|name>");
      }
      const workline = await this.deps.closeWorkline(request.worklineId);
      return success("workline.closed", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "detach") {
      const workline = await this.deps.detachWorkline(request.worklineId);
      return success("workline.detached", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "merge") {
      if (!request.source) {
        return validationError("workline.merge_usage", "用法：workline merge <sourceWorkline>");
      }
      const workline = await this.deps.mergeWorkline(request.source);
      return success("workline.merged", [info(formatWorkline(workline))], { workline });
    }
    return runtimeErrorResult("workline.unknown_action", "未知的 workline 子命令。");
  }
}
