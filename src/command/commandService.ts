import type { CommandRequest, CommandResult } from "../types.js";
import {
  type CommandDomainKey,
  type CommandServiceDependencies,
  buildCommandHandlerDeps,
  normalizeCommandDomain,
} from "./application/commandDeps.js";
import type { CommandHandler } from "./application/commandHandler.js";
import { ApprovalCommandHandler } from "./application/approvalCommandHandler.js";
import { BookmarkCommandHandler } from "./application/bookmarkCommandHandler.js";
import { ClearCommandHandler } from "./application/clearCommandHandler.js";
import {
  prependInfoMessage,
  runtimeErrorResult,
} from "./application/commandResultFactory.js";
import { DebugCommandHandler } from "./application/debugCommandHandler.js";
import { ExecutorCommandHandler } from "./application/executorCommandHandler.js";
import { HookCommandHandler } from "./application/hookCommandHandler.js";
import { MemoryCommandHandler } from "./application/memoryCommandHandler.js";
import { ModelCommandHandler } from "./application/modelCommandHandler.js";
import { RunCommandHandler } from "./application/runCommandHandler.js";
import { SessionCommandHandler } from "./application/sessionCommandHandler.js";
import { SkillsCommandHandler } from "./application/skillsCommandHandler.js";
import { ToolCommandHandler } from "./application/toolCommandHandler.js";
import { WorklineCommandHandler } from "./application/worklineCommandHandler.js";

function isDeprecatedWorkAlias(request: CommandRequest): boolean {
  return request.domain === "work";
}

function toDeprecatedAliasNotice(request: CommandRequest): string | undefined {
  if (isDeprecatedWorkAlias(request)) {
    return "命令 `/work` 已进入兼容期，请改用 `/workline`。";
  }
  return undefined;
}

export class CommandService {
  private readonly handlers: Record<CommandDomainKey, CommandHandler>;

  public constructor(private readonly deps: CommandServiceDependencies) {
    const handlerDeps = buildCommandHandlerDeps(deps);
    this.handlers = {
      run: new RunCommandHandler(handlerDeps.run),
      model: new ModelCommandHandler(handlerDeps.model),
      tool: new ToolCommandHandler(handlerDeps.tool),
      hook: new HookCommandHandler(handlerDeps.hook),
      debug: new DebugCommandHandler(handlerDeps.debug),
      memory: new MemoryCommandHandler(handlerDeps.memory),
      skills: new SkillsCommandHandler(handlerDeps.skills),
      workline: new WorklineCommandHandler(handlerDeps.workline),
      bookmark: new BookmarkCommandHandler(handlerDeps.bookmark),
      executor: new ExecutorCommandHandler(handlerDeps.executor),
      session: new SessionCommandHandler(handlerDeps.session),
      approval: new ApprovalCommandHandler(handlerDeps.approval),
      clear: new ClearCommandHandler(handlerDeps.clear),
    };
  }

  public async execute(request: CommandRequest): Promise<CommandResult> {
    try {
      const handler = this.handlers[normalizeCommandDomain(request)];
      const result = await handler.handle(request as never);
      const aliasNotice = toDeprecatedAliasNotice(request);
      return aliasNotice ? prependInfoMessage(result, aliasNotice) : result;
    } catch (cause) {
      return runtimeErrorResult(
        "command.runtime_error",
        cause instanceof Error ? cause.message : "命令执行失败。",
      );
    }
  }
}

export type { CommandServiceDependencies } from "./application/commandDeps.js";
