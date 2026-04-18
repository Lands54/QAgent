import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { ModelCommandDeps } from "./commandDeps.js";
import {
  info,
  runtimeErrorResult,
  success,
  validationError,
} from "./commandResultFactory.js";

export class ModelCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "model" }>> {
  public constructor(private readonly deps: ModelCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "model" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const status = this.deps.getModelStatus();
      return success(
        "model.status",
        [
          info(
            [
              `provider: ${status.provider}`,
              `model: ${status.model}`,
              `baseUrl: ${status.baseUrl}`,
              `apiKey: ${status.apiKeyMasked ?? "未配置"}`,
              "说明：provider/model 会写入项目 .agent/config.json，apikey 会写入全局 ~/.agent/config.json。",
            ].join("\n"),
          ),
        ],
        status,
      );
    }
    if (request.action === "provider") {
      if (request.provider !== "openai" && request.provider !== "openrouter") {
        return validationError("model.provider_usage", "用法：model provider <openai|openrouter>");
      }
      await this.deps.setModelProvider(request.provider);
      return success("model.provider_updated", [info(`provider 已切换为 ${request.provider}。`)]);
    }
    if (request.action === "name") {
      const modelName = request.model?.trim();
      if (!modelName) {
        return validationError("model.name_usage", "用法：model name <model>");
      }
      await this.deps.setModelName(modelName);
      return success("model.name_updated", [info(`model 已切换为 ${modelName}。`)]);
    }
    if (request.action === "apikey") {
      const apiKey = request.apiKey?.trim();
      if (!apiKey) {
        return validationError("model.apikey_usage", "用法：model apikey <key>");
      }
      await this.deps.setModelApiKey(apiKey);
      return success("model.apikey_updated", [info("API key 已更新。")]);
    }
    return runtimeErrorResult("model.unknown_action", "未知的 model 子命令。");
  }
}
