import type { CommandRequest, CommandResult } from "../../types.js";

export interface CommandHandler<TRequest extends CommandRequest = CommandRequest> {
  handle(request: TRequest): Promise<CommandResult>;
}
