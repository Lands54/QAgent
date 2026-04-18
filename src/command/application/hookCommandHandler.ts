import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { HookCommandDeps } from "./commandDeps.js";
import {
  info,
  success,
  validationError,
} from "./commandResultFactory.js";

export class HookCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "hook" }>> {
  public constructor(private readonly deps: HookCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "hook" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const status = this.deps.getHookStatus();
      return success(
        "hook.status",
        [
          info(
            [
              `fetch-memory: ${status.fetchMemory ? "on" : "off"}`,
              `save-memory: ${status.saveMemory ? "on" : "off"}`,
              `auto-compact: ${status.autoCompact ? "on" : "off"}`,
            ].join("\n"),
          ),
        ],
        status,
      );
    }
    if (request.enabled === undefined) {
      const usage =
        request.action === "fetch-memory"
          ? "hook fetch-memory <on|off>"
          : request.action === "save-memory"
            ? "hook save-memory <on|off>"
            : "hook auto-compact <on|off>";
      return validationError("hook.toggle_usage", `用法：${usage}`);
    }
    const mode = request.enabled ? "on" : "off";
    if (request.action === "fetch-memory") {
      await this.deps.setFetchMemoryHookEnabled(request.enabled);
      return success("hook.updated", [info(`fetch-memory hook 已切换为 ${mode}。`)]);
    }
    if (request.action === "save-memory") {
      await this.deps.setSaveMemoryHookEnabled(request.enabled);
      return success("hook.updated", [info(`save-memory hook 已切换为 ${mode}。`)]);
    }
    await this.deps.setAutoCompactHookEnabled(request.enabled);
    return success("hook.updated", [info(`auto-compact hook 已切换为 ${mode}。`)]);
  }
}
