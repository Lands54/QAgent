import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { DebugCommandDeps } from "./commandDeps.js";
import {
  info,
  success,
  validationError,
} from "./commandResultFactory.js";

export class DebugCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "debug" }>> {
  public constructor(private readonly deps: DebugCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "debug" }>,
  ): Promise<CommandResult> {
    if (request.action === "helper-agent-status") {
      const status = await this.deps.getDebugStatus();
      return success(
        "debug.helper_agent.status",
        [
          info(
            [
              `helper-agent autocleanup: ${status.helperAgentAutoCleanup ? "on" : "off"}`,
              `helper-agent count: ${status.helperAgentCount}`,
              `legacy-agent count: ${status.legacyAgentCount}`,
              `ui-context: ${status.uiContextEnabled ? "on" : "off"}`,
            ].join("\n"),
          ),
        ],
        status,
      );
    }
    if (request.action === "helper-agent-autocleanup") {
      if (request.enabled === undefined) {
        return validationError(
          "debug.helper_agent.autocleanup_usage",
          "用法：debug helper-agent autocleanup <on|off>",
        );
      }
      await this.deps.setHelperAgentAutoCleanupEnabled(request.enabled);
      return success(
        "debug.helper_agent.autocleanup_updated",
        [info(`helper-agent autocleanup 已切换为 ${request.enabled ? "on" : "off"}。`)],
      );
    }
    if (request.action === "helper-agent-clear") {
      const result = await this.deps.clearHelperAgents();
      return success(
        "debug.helper_agent.cleared",
        [
          info(
            result.skippedRunning > 0
              ? `已清理 ${result.cleared} 个 helper agent，跳过 ${result.skippedRunning} 个运行中的 helper agent。`
              : `已清理 ${result.cleared} 个 helper agent。`,
          ),
        ],
        result,
      );
    }
    if (request.action === "legacy-clear") {
      const result = await this.deps.clearLegacyAgents();
      const suffix: string[] = [];
      if (result.skippedRunning > 0) {
        suffix.push(`跳过 ${result.skippedRunning} 个运行中的 legacy agent`);
      }
      if (result.skippedActive > 0) {
        suffix.push(`跳过 ${result.skippedActive} 个当前激活的 legacy agent`);
      }
      return success(
        "debug.legacy.cleared",
        [
          info(
            suffix.length > 0
              ? `已清理 ${result.cleared} 个 legacy agent，${suffix.join("，")}。`
              : `已清理 ${result.cleared} 个 legacy agent。`,
          ),
        ],
        result,
      );
    }
    if (request.action === "ui-context-status") {
      const status = await this.deps.getDebugStatus();
      return success(
        "debug.ui_context.status",
        [info(`ui-context: ${status.uiContextEnabled ? "on" : "off"}`)],
        status,
      );
    }
    if (request.enabled === undefined) {
      return validationError("debug.ui_context_usage", "用法：debug ui-context <on|off>");
    }
    await this.deps.setUiContextEnabled(request.enabled);
    return success(
      "debug.ui_context.updated",
      [info(`ui-context 已切换为 ${request.enabled ? "on" : "off"}。`)],
    );
  }
}
