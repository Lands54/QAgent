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
    if (current === "--transport") {
      const mode = tokens[1];
      if (mode === "local" || mode === "remote") {
        cliOptions.transportMode = mode;
      }
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--workspace") {
      cliOptions.workspaceId = tokens[1];
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--edge-url") {
      cliOptions.edgeBaseUrl = tokens[1];
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--api-token") {
      cliOptions.apiToken = tokens[1];
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--edge-host") {
      cliOptions.edgeBindHost = tokens[1];
      tokens.splice(0, 2);
      continue;
    }
    if (current === "--edge-port") {
      const port = Number(tokens[1]);
      cliOptions.edgePort = Number.isFinite(port) ? port : undefined;
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
