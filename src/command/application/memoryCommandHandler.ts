import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { MemoryCommandDeps } from "./commandDeps.js";
import {
  info,
  runtimeErrorResult,
  success,
  validationError,
} from "./commandResultFactory.js";

export class MemoryCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "memory" }>> {
  public constructor(private readonly deps: MemoryCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "memory" }>,
  ): Promise<CommandResult> {
    if (request.action === "list") {
      const records = await this.deps.listMemory();
      return success(
        "memory.list",
        [
          info(
            records.length === 0
              ? "当前没有 memory。"
              : records
                  .map((record) => `${record.name} | ${record.scope} | ${record.description}`)
                  .join("\n"),
          ),
        ],
        {
          records,
        },
      );
    }
    if (request.action === "show") {
      if (!request.name) {
        return validationError("memory.show_usage", "用法：memory show <name>");
      }
      const record = await this.deps.showMemory(request.name);
      if (!record) {
        return runtimeErrorResult(
          "memory.not_found",
          `未找到 memory：${request.name}`,
          { record },
        );
      }
      return success(
        "memory.show",
        [
          info(
            [
              `id: ${record.id}`,
              `name: ${record.name}`,
              `description: ${record.description}`,
              `scope: ${record.scope}`,
              `directory: ${record.directoryPath}`,
              `path: ${record.path}`,
              "",
              record.content,
            ].join("\n"),
          ),
        ],
        {
          record,
        },
      );
    }
    if (!request.name || !request.description || !request.content) {
      return validationError(
        "memory.save_usage",
        "用法：memory save [--global] --name=<name> --description=<说明> <内容>",
      );
    }
    const record = await this.deps.saveMemory({
      name: request.name,
      description: request.description,
      content: request.content,
      scope: request.scope,
    });
    return success("memory.saved", [info(`已保存 memory：${record.name}`)], {
      record,
    });
  }
}
