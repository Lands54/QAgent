import {
  buildSlashHelpText,
  CommandService,
  type CommandServiceDependencies,
  formatCommandResultUiMessages,
  parseSlashCommand,
} from "../command/index.js";
import type {
  CommandRequest,
  CommandResult,
  SlashCommandResult,
  UIMessage,
} from "../types.js";
import { createId } from "../utils/index.js";

type SlashCommandDependencies = Omit<
  CommandServiceDependencies,
  "clearUi" | "runPrompt" | "getPendingApproval" | "resolvePendingApproval"
> & Partial<Pick<
  CommandServiceDependencies,
  "clearUi" | "runPrompt" | "getPendingApproval" | "resolvePendingApproval"
>>;

function message(role: UIMessage["role"], content: string): UIMessage {
  return {
    id: createId("ui"),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

interface SlashCommandExecutionResult extends SlashCommandResult {
  request?: CommandRequest;
  result?: CommandResult;
}

export class SlashCommandBus {
  private readonly commandService: CommandService;

  public constructor(commandService: CommandService | SlashCommandDependencies) {
    this.commandService = commandService instanceof CommandService
      ? commandService
      : new CommandService({
          ...commandService,
          clearUi: commandService.clearUi ?? (async () => {}),
          runPrompt: commandService.runPrompt
            ?? (async () => {
              throw new Error("当前入口不支持 run 命令。");
            }),
          getPendingApproval: commandService.getPendingApproval
            ?? (async () => undefined),
          resolvePendingApproval: commandService.resolvePendingApproval
            ?? (async () => {
              throw new Error("当前入口不支持 approval 命令。");
            }),
        });
  }

  public async execute(input: string): Promise<SlashCommandResult> {
    const result = await this.executeDetailed(input);
    return {
      handled: result.handled,
      exitRequested: result.exitRequested,
      clearUi: result.clearUi,
      interruptAgent: result.interruptAgent,
      resumeAgent: result.resumeAgent,
      messages: result.messages,
    };
  }

  public async executeDetailed(input: string): Promise<SlashCommandExecutionResult> {
    const parsed = parseSlashCommand(input);
    if (!parsed.handled) {
      return {
        handled: false,
        messages: [],
      };
    }

    if (parsed.kind === "help") {
      return {
        handled: true,
        messages: [message("info", buildSlashHelpText())],
      };
    }

    if (parsed.kind === "exit") {
      return {
        handled: true,
        exitRequested: true,
        messages: [],
      };
    }

    if (parsed.kind === "error") {
      return {
        handled: true,
        messages: [message("error", parsed.message)],
      };
    }

    if (parsed.kind !== "command") {
      return {
        handled: true,
        messages: [],
      };
    }

    const request = parsed.request;
    const result = await this.commandService.execute(request);
    return {
      handled: true,
      request,
      result,
      messages: request.domain === "clear"
        ? []
        : formatCommandResultUiMessages(result),
    };
  }
}
