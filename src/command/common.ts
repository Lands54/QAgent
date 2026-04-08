import type {
  AgentViewState,
  CommandMessage,
  CommandRequest,
  UIMessage,
} from "../types.js";

export interface ParsedCommandTokensResult {
  request?: CommandRequest;
  error?: string;
}

export function splitArgs(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) =>
    token
      .replace(/=(["'])(.*)\1$/u, "=$2")
      .replace(/^["']|["']$/g, ""),
  );
}

export function parseLimit(args: string[], fallback = 20): number {
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  if (!limitArg) {
    return fallback;
  }
  const parsed = Number(limitArg.slice("--limit=".length));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseMessageFlag(args: string[]): string | undefined {
  const messageIndex = args.findIndex((arg) => arg === "-m");
  if (messageIndex >= 0) {
    return args[messageIndex + 1];
  }

  const inlineArg = args.find((arg) => arg.startsWith("-m="));
  if (!inlineArg) {
    return undefined;
  }
  return inlineArg.slice("-m=".length);
}

export function buildSlashHelpText(): string {
  return [
    "可用命令：",
    "/help",
    "/model status",
    "/model provider <openai|openrouter>",
    "/model name <model>",
    "/model apikey <key>",
    "/tool status",
    "/tool confirm <always|risky|never>",
    "/hook status",
    "/hook fetch-memory <on|off>",
    "/hook save-memory <on|off>",
    "/hook auto-compact <on|off>",
    "/debug helper-agent status",
    "/debug ui-context status",
    "/debug ui-context <on|off>",
    "/debug helper-agent autocleanup <on|off>",
    "/debug helper-agent clear",
    "/debug legacy clear",
    "/memory save [--global] --name=<name> --description=<说明> <内容>",
    "/memory list",
    "/memory show <name>",
    "/skills list",
    "/skills show <name|id>",
    "/agent status [agentId|name]",
    "/agent list",
    "/agent spawn <name> [--task|--interactive]",
    "/agent switch <agentId|name>",
    "/agent next",
    "/agent prev",
    "/agent close <agentId|name>",
    "/agent interrupt",
    "/agent resume",
    "/session status",
    "/session commit -m \"<message>\"",
    "/session compact",
    "/session log [--limit=N]",
    "/session graph log [--limit=N]",
    "/session switch <ref>",
    "/session switch -c <branch>",
    "/session branch",
    "/session branch <name>",
    "/session tag",
    "/session tag <name>",
    "/session merge <sourceRef>",
    "/session head status",
    "/session head list",
    "/session head fork <name>",
    "/session head switch <headId>",
    "/session head attach <headId> <ref>",
    "/session head detach <headId>",
    "/session head merge <sourceHeadId>",
    "/session head close <headId>",
    "/approval status",
    "/approval approve [checkpointId]",
    "/approval reject [checkpointId]",
    "/clear",
    "/exit",
  ].join("\n");
}

export function formatAgent(agent: AgentViewState): string {
  const helper = agent.helperType ? ` | helper=${agent.helperType}` : "";
  const pending = agent.pendingApproval ? " | pending=approval" : "";
  return [
    `${agent.id} | name=${agent.name} | kind=${agent.kind}${helper} | status=${agent.status}${pending}`,
    `ref=${agent.sessionRefLabel ?? "N/A"} | shell=${agent.shellCwd} | dirty=${agent.dirty} | detail=${agent.detail}`,
  ].join("\n");
}

export function formatUiMessagesAsText(messages: ReadonlyArray<UIMessage>): string {
  return messages
    .map((message) => message.content)
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
}

export function formatCommandMessages(messages: ReadonlyArray<CommandMessage>): string {
  return messages
    .map((message) => message.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function parseCommandTokens(tokens: string[]): ParsedCommandTokensResult {
  const [domain, subcommand, ...rest] = tokens;
  if (!domain) {
    return {
      error: "空命令。",
    };
  }

  if (domain === "run") {
    return {
      request: {
        domain: "run",
        prompt: rest.length > 0 ? [subcommand, ...rest].filter(Boolean).join(" ") : subcommand ?? "",
      },
    };
  }

  if (domain === "clear") {
    return {
      request: {
        domain: "clear",
      },
    };
  }

  if (domain === "model") {
    return {
      request: {
        domain: "model",
        action:
          subcommand === "provider"
          || subcommand === "name"
          || subcommand === "apikey"
            ? subcommand
            : "status",
        provider: rest[0] === "openai" || rest[0] === "openrouter" ? rest[0] : undefined,
        model: rest.join(" "),
        apiKey: rest.join(" "),
      },
    };
  }

  if (domain === "tool") {
    return {
      request: {
        domain: "tool",
        action: subcommand === "confirm" ? "confirm" : "status",
        mode:
          rest[0] === "always" || rest[0] === "risky" || rest[0] === "never"
            ? rest[0]
            : undefined,
      },
    };
  }

  if (domain === "hook") {
    const enabled = rest[0] === "on" ? true : rest[0] === "off" ? false : undefined;
    if (
      subcommand === "fetch-memory"
      || subcommand === "save-memory"
      || subcommand === "auto-compact"
    ) {
      return {
        request: {
          domain: "hook",
          action: subcommand,
          enabled,
        },
      };
    }
    return {
      request: {
        domain: "hook",
        action: "status",
      },
    };
  }

  if (domain === "debug") {
    if (subcommand === "helper-agent") {
      const action = rest[0] ?? "status";
      if (action === "autocleanup") {
        return {
          request: {
            domain: "debug",
            action: "helper-agent-autocleanup",
            enabled: rest[1] === "on" ? true : rest[1] === "off" ? false : undefined,
          },
        };
      }
      if (action === "clear") {
        return {
          request: {
            domain: "debug",
            action: "helper-agent-clear",
          },
        };
      }
      return {
        request: {
          domain: "debug",
          action: "helper-agent-status",
        },
      };
    }
    if (subcommand === "legacy") {
      return {
        request: {
          domain: "debug",
          action: "legacy-clear",
        },
      };
    }
    if (subcommand === "ui-context") {
      const action = rest[0] ?? "status";
      return {
        request: {
          domain: "debug",
          action: action === "on" || action === "off" ? "ui-context-set" : "ui-context-status",
          enabled: action === "on" ? true : action === "off" ? false : undefined,
        },
      };
    }
    return {
      error: "未知的 debug 命令。",
    };
  }

  if (domain === "memory") {
    if (subcommand === "show") {
      return {
        request: {
          domain: "memory",
          action: "show",
          name: rest[0],
        },
      };
    }
    if (subcommand === "save") {
      let scope: "project" | "global" = "project";
      let name: string | undefined;
      let description: string | undefined;
      const contentTokens: string[] = [];
      for (const arg of rest) {
        if (arg === "--global") {
          scope = "global";
          continue;
        }
        if (arg.startsWith("--name=")) {
          name = arg.slice("--name=".length);
          continue;
        }
        if (arg.startsWith("--description=")) {
          description = arg.slice("--description=".length);
          continue;
        }
        contentTokens.push(arg);
      }
      return {
        request: {
          domain: "memory",
          action: "save",
          name,
          description,
          content: contentTokens.join(" ").trim(),
          scope,
        },
      };
    }
    return {
      request: {
        domain: "memory",
        action: "list",
      },
    };
  }

  if (domain === "skills") {
    return {
      request: {
        domain: "skills",
        action: subcommand === "show" ? "show" : "list",
        key: rest[0],
      },
    };
  }

  if (domain === "agent") {
    if (subcommand === "spawn") {
      return {
        request: {
          domain: "agent",
          action: "spawn",
          name: rest.find((arg) => !arg.startsWith("--")),
          kind: rest.includes("--task") ? "task" : "interactive",
        },
      };
    }
    if (subcommand === "switch" || subcommand === "close" || subcommand === "status") {
      return {
        request: {
          domain: "agent",
          action: subcommand,
          agentId: rest[0],
        },
      };
    }
    if (subcommand === "next" || subcommand === "prev" || subcommand === "interrupt" || subcommand === "resume") {
      return {
        request: {
          domain: "agent",
          action: subcommand,
        },
      };
    }
    return {
      request: {
        domain: "agent",
        action: "list",
      },
    };
  }

  if (domain === "session") {
    if (subcommand === "compact") {
      return { request: { domain: "session", action: "compact" } };
    }
    if (subcommand === "commit") {
      return {
        request: {
          domain: "session",
          action: "commit",
          message: parseMessageFlag(rest),
        },
      };
    }
    if (subcommand === "log") {
      return {
        request: {
          domain: "session",
          action: "log",
          limit: parseLimit(rest),
        },
      };
    }
    if (subcommand === "graph") {
      if (rest[0] !== "log") {
        return {
          error: "用法：session graph log [--limit=N]",
        };
      }
      return {
        request: {
          domain: "session",
          action: "graph-log",
          limit: parseLimit(rest.slice(1)),
        },
      };
    }
    if (subcommand === "branch") {
      return {
        request: {
          domain: "session",
          action: rest.length > 0 || tokens.length > 2 ? "branch-create" : "branch-list",
          name: rest[0],
        },
      };
    }
    if (subcommand === "switch") {
      if (rest[0] === "-c") {
        return {
          request: {
            domain: "session",
            action: "switch-create-branch",
            name: rest[1],
          },
        };
      }
      return {
        request: {
          domain: "session",
          action: "switch",
          ref: rest[0],
        },
      };
    }
    if (subcommand === "tag") {
      return {
        request: {
          domain: "session",
          action: rest.length > 0 || tokens.length > 2 ? "tag-create" : "tag-list",
          name: rest[0],
        },
      };
    }
    if (subcommand === "merge") {
      return {
        request: {
          domain: "session",
          action: "merge",
          ref: rest[0],
        },
      };
    }
    if (subcommand === "head") {
      const headCommand = rest[0];
      const headArgs = rest.slice(1);
      if (headCommand === "fork") {
        return { request: { domain: "session", action: "head-fork", name: headArgs[0] } };
      }
      if (headCommand === "switch") {
        return { request: { domain: "session", action: "head-switch", headId: headArgs[0] } };
      }
      if (headCommand === "attach") {
        return {
          request: {
            domain: "session",
            action: "head-attach",
            headId: headArgs[0],
            ref: headArgs[1],
          },
        };
      }
      if (headCommand === "detach") {
        return { request: { domain: "session", action: "head-detach", headId: headArgs[0] } };
      }
      if (headCommand === "merge") {
        return {
          request: {
            domain: "session",
            action: "head-merge",
            sourceHeadId: headArgs[0],
          },
        };
      }
      if (headCommand === "close") {
        return { request: { domain: "session", action: "head-close", headId: headArgs[0] } };
      }
      if (headCommand === "list") {
        return { request: { domain: "session", action: "head-list" } };
      }
      return { request: { domain: "session", action: "head-status" } };
    }
    if (subcommand === "list") {
      return {
        error: "/session list 已废弃。请改用 /session branch 或 /session tag。",
      };
    }
    if (subcommand === "fork") {
      return {
        error: "/session fork 已废弃。请改用 /session switch -c <branch>。",
      };
    }
    if (subcommand === "checkout") {
      return {
        error: "/session checkout 已废弃。请改用 /session switch <ref>。",
      };
    }
    return {
      request: {
        domain: "session",
        action: "status",
      },
    };
  }

  if (domain === "approval") {
    if (subcommand === "approve" || subcommand === "reject") {
      return {
        request: {
          domain: "approval",
          action: subcommand,
          checkpointId: rest[0],
        },
      };
    }
    return {
      request: {
        domain: "approval",
        action: "status",
        checkpointId: rest[0],
      },
    };
  }

  return {
    error: `未知命令：${domain}`,
  };
}
