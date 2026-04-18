import type {
  CommandMessage,
  CommandResult,
  PendingApprovalCheckpoint,
  UIMessage,
} from "../../types.js";

export function info(text: string, title?: string): CommandMessage {
  return {
    level: "info",
    text,
    title,
  };
}

export function error(text: string, title?: string): CommandMessage {
  return {
    level: "error",
    text,
    title,
  };
}

export function success(
  code: string,
  messages: ReadonlyArray<CommandMessage> = [],
  payload?: unknown,
  exitCode = 0,
): CommandResult {
  return {
    status: "success",
    code,
    exitCode,
    messages,
    payload,
  };
}

export function validationError(code: string, text: string): CommandResult {
  return {
    status: "validation_error",
    code,
    exitCode: 2,
    messages: [error(text)],
  };
}

export function runtimeErrorResult(
  code: string,
  text: string,
  payload?: unknown,
): CommandResult {
  return {
    status: "runtime_error",
    code,
    exitCode: 1,
    messages: [error(text)],
    payload,
  };
}

export function approvalRequired(
  checkpoint: PendingApprovalCheckpoint,
  uiMessages: ReadonlyArray<UIMessage> = [],
): CommandResult {
  return {
    status: "approval_required",
    code: "approval.required",
    exitCode: 3,
    messages: [
      info(
        `命令需要审批后才能继续。checkpoint=${checkpoint.checkpointId} tool=${checkpoint.toolCall.input.command}`,
      ),
    ],
    payload: {
      checkpoint,
      uiMessages,
    },
  };
}

export function prependInfoMessage(
  result: CommandResult,
  text: string,
): CommandResult {
  return {
    ...result,
    messages: [info(text), ...result.messages],
  };
}
