import type { CommandRequest } from "../types.js";
import { parseCommandTokens, splitArgs } from "./common.js";

export type SlashParseResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      kind: "help" | "exit";
    }
  | {
      handled: true;
      kind: "command";
      request: CommandRequest;
    }
  | {
      handled: true;
      kind: "error";
      message: string;
    };

export function parseSlashCommand(input: string): SlashParseResult {
  if (!input.startsWith("/")) {
    return {
      handled: false,
    };
  }

  const tokens = splitArgs(input.slice(1).trim());
  const [command, ...rest] = tokens;
  if (!command) {
    return {
      handled: true,
      kind: "error",
      message: "空的斜杠命令。",
    };
  }

  if (command === "help") {
    return {
      handled: true,
      kind: "help",
    };
  }

  if (command === "exit") {
    return {
      handled: true,
      kind: "exit",
    };
  }

  const parsed = parseCommandTokens([command, ...rest]);
  if (!parsed.request) {
    return {
      handled: true,
      kind: "error",
      message: parsed.error ?? "命令解析失败。",
    };
  }

  return {
    handled: true,
    kind: "command",
    request: parsed.request,
  };
}
