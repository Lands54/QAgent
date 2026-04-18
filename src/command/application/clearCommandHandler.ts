import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { ClearCommandDeps } from "./commandDeps.js";
import {
  info,
  success,
} from "./commandResultFactory.js";

export class ClearCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "clear" }>> {
  public constructor(private readonly deps: ClearCommandDeps) {}

  public async handle(): Promise<CommandResult> {
    await this.deps.clearUi();
    return success("clear.success", [info("已清空当前工位的 UI 消息。")]);
  }
}
