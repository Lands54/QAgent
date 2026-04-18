import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { SkillsCommandDeps } from "./commandDeps.js";
import {
  info,
  runtimeErrorResult,
  success,
  validationError,
} from "./commandResultFactory.js";

export class SkillsCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "skills" }>> {
  public constructor(private readonly deps: SkillsCommandDeps) {}

  public async handle(
    request: Extract<CommandRequest, { domain: "skills" }>,
  ): Promise<CommandResult> {
    const skills = this.deps.getAvailableSkills();
    if (request.action === "list") {
      return success(
        "skills.list",
        [
          info(
            skills.length === 0
              ? "当前没有可用 skills。"
              : skills.map((skill) => `${skill.id} | ${skill.description}`).join("\n"),
          ),
        ],
        {
          skills,
        },
      );
    }

    if (!request.key) {
      return validationError("skills.show_usage", "用法：skills show <name|id>");
    }
    const skill = skills.find((item) => item.id === request.key || item.name === request.key);
    if (!skill) {
      return runtimeErrorResult(
        "skills.not_found",
        `未找到 skill：${request.key}`,
        { skill },
      );
    }
    return success(
      "skills.show",
      [
        info(
          [
            `id: ${skill.id}`,
            `name: ${skill.name}`,
            `description: ${skill.description}`,
            `path: ${skill.filePath}`,
            "说明：不需要手动激活，模型会在合适时自动使用。",
          ].join("\n"),
        ),
      ],
      {
        skill,
      },
    );
  }
}
