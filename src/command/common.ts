import type {
  BookmarkView,
  CommandMessage,
  CommandRequest,
  ExecutorView,
  UIMessage,
  WorklineView,
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
    "/work status [worklineId|name]",
    "/work list",
    "/work new <name>",
    "/work switch <worklineId|name>",
    "/work next",
    "/work prev",
    "/work close <worklineId|name>",
    "/work detach [worklineId|name]",
    "/work merge <sourceWorkline>",
    "/bookmark status",
    "/bookmark list",
    "/bookmark save <name>",
    "/bookmark tag <name>",
    "/bookmark switch <name>",
    "/bookmark merge <sourceBookmark>",
    "/executor status [executorId|name]",
    "/executor list",
    "/executor interrupt [executorId|name]",
    "/executor resume [executorId|name]",
    "/session commit -m \"<message>\"",
    "/session compact",
    "/session reset-context",
    "/session log [--limit=N]",
    "/session graph log [--limit=N]",
    "/approval status",
    "/approval approve [checkpointId]",
    "/approval reject [checkpointId]",
    "/clear",
    "/exit",
  ].join("\n");
}

export function formatWorkline(workline: WorklineView): string {
  const helper = workline.helperType ? ` | helper=${workline.helperType}` : "";
  const pending = workline.pendingApproval ? " | pending=approval" : "";
  return [
    `${workline.id} | name=${workline.name}${helper} | status=${workline.status}${pending}`,
    `bookmark=${workline.attachmentLabel} | shell=${workline.shellCwd} | dirty=${workline.dirty} | detail=${workline.detail}`,
  ].join("\n");
}

export function formatBookmark(bookmark: BookmarkView): string {
  return `${bookmark.kind} | ${bookmark.name} -> ${bookmark.targetNodeId}${bookmark.current ? " | current" : ""}`;
}

export function formatExecutor(executor: ExecutorView): string {
  const helper = executor.helperType ? ` | helper=${executor.helperType}` : "";
  const pending = executor.pendingApproval ? " | pending=approval" : "";
  return [
    `${executor.executorId} | name=${executor.name} | kind=${executor.kind}${helper} | status=${executor.status}${pending}`,
    `workline=${executor.worklineName} | bookmark=${executor.sessionRefLabel ?? "N/A"} | shell=${executor.shellCwd} | detail=${executor.detail}`,
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

  if (domain === "work") {
    if (subcommand === "new") {
      return {
        request: {
          domain: "work",
          action: "new",
          name: rest[0],
        },
      };
    }
    if (subcommand === "switch" || subcommand === "close" || subcommand === "status" || subcommand === "detach") {
      return {
        request: {
          domain: "work",
          action: subcommand,
          worklineId: rest[0],
        },
      };
    }
    if (subcommand === "merge") {
      return {
        request: {
          domain: "work",
          action: "merge",
          source: rest[0],
        },
      };
    }
    if (subcommand === "next" || subcommand === "prev") {
      return {
        request: {
          domain: "work",
          action: subcommand,
        },
      };
    }
    return {
      request: {
        domain: "work",
        action: "list",
      },
    };
  }

  if (domain === "bookmark") {
    if (subcommand === "save" || subcommand === "tag") {
      return {
        request: {
          domain: "bookmark",
          action: subcommand,
          name: rest[0],
        },
      };
    }
    if (subcommand === "switch" || subcommand === "merge") {
      return {
        request: {
          domain: "bookmark",
          action: subcommand,
          [subcommand === "switch" ? "bookmark" : "source"]: rest[0],
        } as Extract<CommandRequest, { domain: "bookmark" }>,
      };
    }
    return {
      request: {
        domain: "bookmark",
        action: subcommand === "status" ? "status" : "list",
      },
    };
  }

  if (domain === "executor") {
    if (subcommand === "status" || subcommand === "interrupt" || subcommand === "resume") {
      return {
        request: {
          domain: "executor",
          action: subcommand,
          executorId: rest[0],
        },
      };
    }
    return {
      request: {
        domain: "executor",
        action: "list",
      },
    };
  }

  if (domain === "session") {
    if (subcommand === "compact") {
      return { request: { domain: "session", action: "compact" } };
    }
    if (subcommand === "reset-context") {
      return { request: { domain: "session", action: "reset-context" } };
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
    if (subcommand === "status") {
      return {
        error: "/session status 已移除。请改用 /work status。",
      };
    }
    if (subcommand === "branch") {
      return {
        error: rest.length > 0 || tokens.length > 2
          ? "/session branch <name> 已移除。请改用 /bookmark save <name>。"
          : "/session branch 已移除。请改用 /bookmark list。",
      };
    }
    if (subcommand === "switch") {
      return {
        error: rest[0] === "-c"
          ? "/session switch -c <branch> 已移除。请改用 /work new <name>。"
          : "/session switch <ref> 已移除。请改用 /bookmark switch <name>。",
      };
    }
    if (subcommand === "tag") {
      return {
        error: rest.length > 0 || tokens.length > 2
          ? "/session tag <name> 已移除。请改用 /bookmark tag <name>。"
          : "/session tag 已移除。请改用 /bookmark list。",
      };
    }
    if (subcommand === "merge") {
      return {
        error: "/session merge <sourceRef> 已移除。请改用 /bookmark merge <sourceBookmark>。",
      };
    }
    if (subcommand === "head") {
      return {
        error: "/session head 系列命令已移除。请改用 /work ...。",
      };
    }
    if (subcommand === "list") {
      return {
        error: "/session list 已移除。请改用 /bookmark list。",
      };
    }
    if (subcommand === "fork") {
      return {
        error: "/session fork 已移除。请改用 /work new <name>。",
      };
    }
    if (subcommand === "checkout") {
      return {
        error: "/session checkout 已移除。请改用 /bookmark switch <name>。",
      };
    }
    return {
      error: "未知的 session 命令。",
    };
  }

  if (domain === "agent") {
    return {
      error: "/agent 系列命令已移除。请改用 /work 或 /executor。",
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
