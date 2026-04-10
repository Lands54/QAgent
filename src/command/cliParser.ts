import type { CliOptions, CommandRequest } from "../types.js";
import { parseCommandTokens } from "./common.js";

export interface ParsedCliInvocation {
  cliOptions: CliOptions;
  mode: "tui" | "help" | "command" | "gateway" | "edge";
  output: "text" | "json" | "stream";
  request?: CommandRequest;
  gatewayAction?: "serve" | "status" | "stop";
  edgeAction?: "serve" | "status" | "stop";
  error?: string;
}

function parseOptionError(
  cliOptions: CliOptions,
  output: ParsedCliInvocation["output"],
  error: string,
): ParsedCliInvocation {
  return {
    cliOptions,
    mode: "help",
    output,
    error,
  };
}

function isOptionToken(value: string): boolean {
  return value === "-h" || value.startsWith("--");
}

function readOptionValue(
  tokens: string[],
  optionName: string,
): { value: string } | { error: string } {
  const value = tokens[1];
  if (!value || isOptionToken(value)) {
    return {
      error: `选项 ${optionName} 需要一个值。`,
    };
  }

  return { value };
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
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      cliOptions.cwd = result.value;
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--config") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      cliOptions.configPath = result.value;
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--provider") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      const provider = result.value;
      if (provider === "openai" || provider === "openrouter") {
        cliOptions.provider = provider;
      } else {
        return parseOptionError(
          cliOptions,
          output,
          "选项 --provider 仅支持 openai 或 openrouter。",
        );
      }
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--model") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      cliOptions.model = result.value;
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--transport") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      const mode = result.value;
      if (mode === "local" || mode === "remote") {
        cliOptions.transportMode = mode;
      } else {
        return parseOptionError(
          cliOptions,
          output,
          "选项 --transport 仅支持 local 或 remote。",
        );
      }
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--workspace") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      cliOptions.workspaceId = result.value;
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--edge-url") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      cliOptions.edgeBaseUrl = result.value;
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--api-token") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      cliOptions.apiToken = result.value;
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--edge-host") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      cliOptions.edgeBindHost = result.value;
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--edge-port") {
      const result = readOptionValue(tokens, current);
      if ("error" in result) {
        return parseOptionError(cliOptions, output, result.error);
      }
      const port = Number(result.value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        return parseOptionError(
          cliOptions,
          output,
          "选项 --edge-port 需要 0 到 65535 之间的整数。",
        );
      }
      cliOptions.edgePort = port;
      tokens.splice(0, 2);
      continue;
    }
    break;
  }

  if (tokens.length === 0) {
    return {
      cliOptions,
      mode: "help",
      output,
    };
  }

  if (tokens[0] === "tui") {
    const prompt = tokens.slice(1).join(" ").trim();
    if (prompt) {
      cliOptions.initialPrompt = prompt;
    }
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

  if (tokens[0] === "gateway") {
    const action = tokens[1];
    if (action === "serve" || action === "status" || action === "stop") {
      return {
        cliOptions,
        mode: "gateway",
        output,
        gatewayAction: action,
      };
    }
    return {
      cliOptions,
      mode: "help",
      output,
      error: "用法：qagent gateway <serve|status|stop>",
    };
  }

  if (tokens[0] === "edge") {
    const action = tokens[1];
    if (action === "serve" || action === "status" || action === "stop") {
      return {
        cliOptions,
        mode: "edge",
        output,
        edgeAction: action,
      };
    }
    return {
      cliOptions,
      mode: "help",
      output,
      error: "用法：qagent edge <serve|status|stop>",
    };
  }

  const trailingTokens = tokens.filter((token) => token !== "--json" && token !== "--stream");
  if (trailingTokens.length !== tokens.length) {
    if (tokens.includes("--json") && tokens.includes("--stream")) {
      return {
        cliOptions,
        mode: "help",
        output,
        error: "--json 与 --stream 不能同时使用。",
      };
    }
    if (tokens.includes("--json")) {
      output = "json";
    }
    if (tokens.includes("--stream")) {
      output = "stream";
    }
  }

  const parsed = parseCommandTokens(trailingTokens);
  if (!parsed.request) {
    const knownDomains = new Set([
      "run",
      "model",
      "tool",
      "hook",
      "debug",
      "memory",
      "skills",
      "work",
      "bookmark",
      "executor",
      "session",
      "approval",
      "clear",
    ]);
    if (!knownDomains.has(tokens[0] ?? "")) {
      return {
        cliOptions,
        mode: "command",
        output,
        request: {
          domain: "run",
          prompt: trailingTokens.join(" "),
        },
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
