import { formatExecutor } from "../common.js";
import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { ExecutorCommandDeps } from "./commandDeps.js";
import {
  info,
  runtimeErrorResult,
  success,
} from "./commandResultFactory.js";

export class ExecutorCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "executor" }>> {
  public constructor(private readonly deps: ExecutorCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "executor" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const executor = await this.deps.getExecutorStatus(request.executorId);
      return success("executor.status", [info(formatExecutor(executor))], { executor });
    }
    if (request.action === "list") {
      const executors = await this.deps.listExecutors();
      return success(
        "executor.list",
        [
          info(
            executors.executors.length === 0
              ? "当前没有执行器。"
              : executors.executors.map((executor) => formatExecutor(executor)).join("\n\n"),
          ),
        ],
        executors,
      );
    }
    if (request.action === "interrupt") {
      await this.deps.interruptExecutor(request.executorId);
      return success("executor.interrupted", [info("已发送中断给目标执行器。")]);
    }
    if (request.action === "resume") {
      await this.deps.resumeExecutor(request.executorId);
      return success("executor.resumed", [info("已尝试继续目标执行器。")]);
    }
    return runtimeErrorResult("executor.unknown_action", "未知的 executor 子命令。");
  }
}
