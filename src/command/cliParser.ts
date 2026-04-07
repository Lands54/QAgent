import type { CliOptions, CommandRequest } from "../types.js";
import { parseCommandTokens } from "./common.js";

export interface ParsedCliInvocation {
  cliOptions: CliOptions;
  mode: "tui" | "help" | "command";
  output: "text" | "json" | "stream";
  request?: CommandRequest;
  error?: string;
}

export function parseCliInvocation(argv: string[]): ParsedCliInvocation {
  const cliOptions: CliOptions = {};
  let output: ParsedCliInvocation["output"] = "text";
  const tokens = [...argv];

  while (tokens.length > 0) {
    const current = tokens[0];
    if (!current) {
      tokens.shift();
      continue;
    }
    if (current === "-h" || current === "--help") {
      return {
        cliOptions,
        mode: "help",
        output,
      };
    }
    if (current === "--json") {
      if (output === "stream") {
        return {
          cliOptions,
          mode: "help",
          output,
          error: "--json 与 --stream 不能同时使用。",
        };
      }
      output = "json";
      tokens.shift();
      continue;
    }
    if (current === "--stream") {
      if (output === "json") {
        return {
          cliOptions,
          mode: "help",
          output,
          error: "--json 与 --stream 不能同时使用。",
        };
      }
      output = "stream";
      tokens.shift();
      continue;
    }
    if (current === "--cwd") {
      cliOptions.cwd = tokens[1];
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--config") {
      cliOptions.configPath = tokens[1];
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--provider") {
      const provider = tokens[1];
      if (provider === "openai" || provider === "openrouter") {
        cliOptions.provider = provider;
      }
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--model") {
      cliOptions.model = tokens[1];
      tokens.splice(0, 2);
      continue;
    }
    break;
  }

  if (tokens.length === 0) {
    return {
      cliOptions,
      mode: "tui",
      output,
    };
  }

  if (tokens[0] === "resume") {
    cliOptions.resumeSessionId = tokens[1] ?? "latest";
    return {
      cliOptions,
      mode: "tui",
      output,
    };
  }

  const parsed = parseCommandTokens(tokens);
  if (!parsed.request) {
    const knownDomains = new Set([
      "run",
      "model",
      "tool",
      "hook",
      "debug",
      "memory",
      "skills",
      "agent",
      "session",
      "approval",
      "clear",
    ]);
    if (!knownDomains.has(tokens[0] ?? "")) {
      return {
        cliOptions: {
          ...cliOptions,
          initialPrompt: tokens.join(" "),
        },
        mode: "tui",
        output,
      };
    }
    return {
      cliOptions,
      mode: "command",
      output,
      error: parsed.error ?? "命令解析失败。",
    };
  }

  return {
    cliOptions,
    mode: "command",
    output,
    request: parsed.request,
  };
}
