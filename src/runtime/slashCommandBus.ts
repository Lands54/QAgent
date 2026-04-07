import type {
  AgentKind,
  AgentViewState,
  ApprovalMode,
  MemoryRecord,
  ModelProvider,
  SessionHeadListView,
  SessionListView,
  SessionLogEntry,
  SessionRefInfo,
  SkillManifest,
  SlashCommandResult,
  UIMessage,
} from "../types.js";
import { createId } from "../utils/index.js";

interface SlashCommandDependencies {
  getSessionId: () => string;
  getActiveHeadId: () => string;
  getActiveAgentId?: () => string;
  getShellCwd: () => string;
  getHookStatus: () => {
    fetchMemory: boolean;
    saveMemory: boolean;
    autoCompact: boolean;
  };
  getDebugStatus: () => Promise<{
    helperAgentAutoCleanup: boolean;
    helperAgentCount: number;
    legacyAgentCount: number;
    uiContextEnabled: boolean;
  }>;
  getApprovalMode: () => ApprovalMode;
  getModelStatus: () => {
    provider: ModelProvider;
    model: string;
    baseUrl: string;
    apiKeyMasked?: string;
  };
  getStatusLine: () => string;
  getAvailableSkills: () => SkillManifest[];
  setApprovalMode: (mode: ApprovalMode) => Promise<void>;
  setFetchMemoryHookEnabled: (enabled: boolean) => Promise<void>;
  setSaveMemoryHookEnabled: (enabled: boolean) => Promise<void>;
  setAutoCompactHookEnabled: (enabled: boolean) => Promise<void>;
  setUiContextEnabled: (enabled: boolean) => Promise<void>;
  setHelperAgentAutoCleanupEnabled: (enabled: boolean) => Promise<void>;
  setModelProvider: (provider: ModelProvider) => Promise<void>;
  setModelName: (model: string) => Promise<void>;
  setModelApiKey: (apiKey: string) => Promise<void>;
  listMemory: (limit?: number) => Promise<MemoryRecord[]>;
  saveMemory: (input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }) => Promise<MemoryRecord>;
  showMemory: (name: string) => Promise<MemoryRecord | undefined>;
  getAgentStatus: (agentId?: string) => Promise<AgentViewState>;
  listAgents: () => Promise<AgentViewState[]>;
  spawnAgent: (name: string, kind: AgentKind) => Promise<AgentViewState>;
  switchAgent: (agentId: string) => Promise<AgentViewState>;
  switchAgentRelative: (offset: number) => Promise<AgentViewState>;
  closeAgent: (agentId: string) => Promise<AgentViewState>;
  interruptAgent: () => Promise<void>;
  resumeAgent: () => Promise<void>;
  getSessionGraphStatus: () => Promise<SessionRefInfo>;
  listSessionRefs: () => Promise<SessionListView>;
  listSessionHeads: () => Promise<SessionHeadListView>;
  listSessionLog: (limit?: number) => Promise<SessionLogEntry[]>;
  compactSession: () => Promise<{
    compacted: boolean;
    agentId?: string;
    beforeTokens: number;
    afterTokens: number;
    keptGroups: number;
    removedGroups: number;
  }>;
  createSessionBranch: (name: string) => Promise<SessionRefInfo>;
  forkSessionBranch: (name: string) => Promise<SessionRefInfo>;
  checkoutSessionRef: (ref: string) => Promise<SessionCheckoutResultLike>;
  createSessionTag: (name: string) => Promise<SessionRefInfo>;
  mergeSessionRef: (ref: string) => Promise<SessionRefInfo>;
  forkSessionHead: (name: string) => Promise<SessionRefInfo>;
  switchSessionHead: (headId: string) => Promise<SessionRefInfo>;
  attachSessionHead: (headId: string, ref: string) => Promise<SessionRefInfo>;
  detachSessionHead: (headId: string) => Promise<SessionRefInfo>;
  mergeSessionHead: (sourceHeadId: string) => Promise<SessionRefInfo>;
  closeSessionHead: (headId: string) => Promise<SessionRefInfo>;
  clearHelperAgents: () => Promise<{
    cleared: number;
    skippedRunning: number;
  }>;
  clearLegacyAgents: () => Promise<{
    cleared: number;
    skippedRunning: number;
    skippedActive: number;
  }>;
}

interface SessionCheckoutResultLike {
  ref: SessionRefInfo;
  message: string;
}

function message(role: UIMessage["role"], content: string): UIMessage {
  return {
    id: createId("ui"),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

function splitArgs(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) =>
    token
      .replace(/=(["'])(.*)\1$/u, "=$2")
      .replace(/^["']|["']$/g, ""),
  );
}

function helpMessage(): string {
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
    "/session compact",
    "/session list",
    "/session log [--limit=N]",
    "/session branch <name>",
    "/session fork <name>",
    "/session checkout <ref>",
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
    "/clear",
    "/exit",
  ].join("\n");
}

function formatAgent(agent: AgentViewState): string {
  const helper = agent.helperType ? ` | helper=${agent.helperType}` : "";
  const pending = agent.pendingApproval ? " | pending=approval" : "";
  return [
    `${agent.id} | name=${agent.name} | kind=${agent.kind}${helper} | status=${agent.status}${pending}`,
    `ref=${agent.sessionRefLabel ?? "N/A"} | shell=${agent.shellCwd} | dirty=${agent.dirty} | detail=${agent.detail}`,
  ].join("\n");
}

export class SlashCommandBus {
  public constructor(private readonly deps: SlashCommandDependencies) {}

  public async execute(input: string): Promise<SlashCommandResult> {
    if (!input.startsWith("/")) {
      return {
        handled: false,
        messages: [],
      };
    }

    const tokens = splitArgs(input.slice(1).trim());
    const [command, subcommand, ...rest] = tokens;
    if (!command) {
      return {
        handled: true,
        messages: [message("error", "空的斜杠命令。")],
      };
    }

    try {
      switch (command) {
        case "help":
          return {
            handled: true,
            messages: [message("info", helpMessage())],
          };
        case "model":
          return this.handleModel(subcommand, rest);
        case "tool":
          return this.handleTool(subcommand, rest);
        case "hook":
          return this.handleHook(subcommand, rest);
        case "debug":
          return this.handleDebug(subcommand, rest);
        case "memory":
          return this.handleMemory(subcommand, rest);
        case "skills":
          return this.handleSkills(subcommand, rest);
        case "agent":
          return this.handleAgent(subcommand, rest);
        case "session":
          return this.handleSession(subcommand, rest);
        case "clear":
          return {
            handled: true,
            clearUi: true,
            messages: [],
          };
        case "exit":
          return {
            handled: true,
            exitRequested: true,
            messages: [],
          };
        default:
          return {
            handled: true,
            messages: [message("error", `未知命令：/${command}`)],
          };
      }
    } catch (error) {
      return {
        handled: true,
        messages: [
          message(
            "error",
            error instanceof Error ? error.message : "命令执行失败。",
          ),
        ],
      };
    }
  }

  private async handleModel(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (!subcommand || subcommand === "status") {
      const status = this.deps.getModelStatus();
      return {
        handled: true,
        messages: [
          message(
            "info",
            [
              `provider: ${status.provider}`,
              `model: ${status.model}`,
              `baseUrl: ${status.baseUrl}`,
              `apiKey: ${status.apiKeyMasked ?? "未配置"}`,
              "说明：provider/model 会写入项目 .agent/config.json，apikey 会写入全局 ~/.agent/config.json。",
            ].join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "provider") {
      const provider = args[0];
      if (provider !== "openai" && provider !== "openrouter") {
        return {
          handled: true,
          messages: [message("error", "用法：/model provider <openai|openrouter>")],
        };
      }
      await this.deps.setModelProvider(provider);
      return {
        handled: true,
        messages: [
          message("info", `provider 已切换为 ${provider}。`),
        ],
      };
    }

    if (subcommand === "name") {
      const modelName = args.join(" ").trim();
      if (!modelName) {
        return {
          handled: true,
          messages: [message("error", "用法：/model name <model>")],
        };
      }
      await this.deps.setModelName(modelName);
      return {
        handled: true,
        messages: [message("info", `model 已切换为 ${modelName}。`)],
      };
    }

    if (subcommand === "apikey") {
      const apiKey = args.join(" ").trim();
      if (!apiKey) {
        return {
          handled: true,
          messages: [message("error", "用法：/model apikey <key>")],
        };
      }
      await this.deps.setModelApiKey(apiKey);
      return {
        handled: true,
        messages: [message("info", "API key 已更新。")],
      };
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /model 子命令。")],
    };
  }

  private async handleTool(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (!subcommand || subcommand === "status") {
      return {
        handled: true,
        messages: [
          message(
            "info",
            [
              `approvalMode: ${this.deps.getApprovalMode()}`,
              `shellCwd: ${this.deps.getShellCwd()}`,
            ].join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "confirm") {
      const mode = args[0];
      if (mode !== "always" && mode !== "risky" && mode !== "never") {
        return {
          handled: true,
          messages: [message("error", "用法：/tool confirm <always|risky|never>")],
        };
      }
      await this.deps.setApprovalMode(mode);
      return {
        handled: true,
        messages: [message("info", `approval mode 已切换为 ${mode}。`)],
      };
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /tool 子命令。")],
    };
  }

  private async handleHook(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (!subcommand || subcommand === "status") {
      const status = this.deps.getHookStatus();
      return {
        handled: true,
        messages: [
          message(
            "info",
            [
              `fetch-memory: ${status.fetchMemory ? "on" : "off"}`,
              `save-memory: ${status.saveMemory ? "on" : "off"}`,
              `auto-compact: ${status.autoCompact ? "on" : "off"}`,
            ].join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "fetch-memory") {
      const mode = args[0];
      if (mode !== "on" && mode !== "off") {
        return {
          handled: true,
          messages: [message("error", "用法：/hook fetch-memory <on|off>")],
        };
      }
      await this.deps.setFetchMemoryHookEnabled(mode === "on");
      return {
        handled: true,
        messages: [message("info", `fetch-memory hook 已切换为 ${mode}。`)],
      };
    }

    if (subcommand === "save-memory") {
      const mode = args[0];
      if (mode !== "on" && mode !== "off") {
        return {
          handled: true,
          messages: [message("error", "用法：/hook save-memory <on|off>")],
        };
      }
      await this.deps.setSaveMemoryHookEnabled(mode === "on");
      return {
        handled: true,
        messages: [message("info", `save-memory hook 已切换为 ${mode}。`)],
      };
    }

    if (subcommand === "auto-compact") {
      const mode = args[0];
      if (mode !== "on" && mode !== "off") {
        return {
          handled: true,
          messages: [message("error", "用法：/hook auto-compact <on|off>")],
        };
      }
      await this.deps.setAutoCompactHookEnabled(mode === "on");
      return {
        handled: true,
        messages: [message("info", `auto-compact hook 已切换为 ${mode}。`)],
      };
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /hook 子命令。")],
    };
  }

  private async handleMemory(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (subcommand === "list" || !subcommand) {
      const records = await this.deps.listMemory();
      return {
        handled: true,
        messages: [
          message(
            "info",
            records.length === 0
              ? "当前没有 memory。"
              : records
                  .map(
                    (record) =>
                      `${record.name} | ${record.scope} | ${record.description}`,
                  )
                  .join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "show") {
      const name = args[0];
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/memory show <name>")],
        };
      }
      const record = await this.deps.showMemory(name);
      return {
        handled: true,
        messages: [
          message(
            record ? "info" : "error",
            record
              ? [
                  `id: ${record.id}`,
                  `name: ${record.name}`,
                  `description: ${record.description}`,
                  `scope: ${record.scope}`,
                  `directory: ${record.directoryPath}`,
                  `path: ${record.path}`,
                  "",
                  record.content,
                ].join("\n")
              : `未找到 memory：${name}`,
          ),
        ],
      };
    }

    if (subcommand === "save") {
      let scope: "project" | "global" = "project";
      let name: string | undefined;
      let description: string | undefined;
      const contentTokens: string[] = [];

      for (const arg of args) {
        if (arg === "--global") {
          scope = "global";
        } else if (arg.startsWith("--name=")) {
          name = arg.slice("--name=".length);
        } else if (arg.startsWith("--description=")) {
          description = arg.slice("--description=".length);
        } else {
          contentTokens.push(arg);
        }
      }

      const content = contentTokens.join(" ").trim();
      if (!name || !description || !content) {
        return {
          handled: true,
          messages: [
            message(
              "error",
              "用法：/memory save [--global] --name=<name> --description=<说明> <内容>",
            ),
          ],
        };
      }

      const record = await this.deps.saveMemory({
        name,
        description,
        content,
        scope,
      });
      return {
        handled: true,
        messages: [message("info", `已保存 memory：${record.name}`)],
      };
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /memory 子命令。")],
    };
  }

  private async handleDebug(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (subcommand === "helper-agent") {
      const action = args[0] ?? "status";
      if (action === "status") {
        const status = await this.deps.getDebugStatus();
        return {
          handled: true,
          messages: [
            message(
              "info",
              [
                `helper-agent autocleanup: ${status.helperAgentAutoCleanup ? "on" : "off"}`,
                `helper-agent count: ${status.helperAgentCount}`,
                `legacy-agent count: ${status.legacyAgentCount}`,
                `ui-context: ${status.uiContextEnabled ? "on" : "off"}`,
              ].join("\n"),
            ),
          ],
        };
      }

      if (action === "autocleanup") {
        const mode = args[1];
        if (mode !== "on" && mode !== "off") {
          return {
            handled: true,
            messages: [
              message(
                "error",
                "用法：/debug helper-agent autocleanup <on|off>",
              ),
            ],
          };
        }
        await this.deps.setHelperAgentAutoCleanupEnabled(mode === "on");
        return {
          handled: true,
          messages: [
            message("info", `helper-agent autocleanup 已切换为 ${mode}。`),
          ],
        };
      }

      if (action === "clear") {
        const result = await this.deps.clearHelperAgents();
        return {
          handled: true,
          messages: [
            message(
              "info",
              result.skippedRunning > 0
                ? `已清理 ${result.cleared} 个 helper agent，跳过 ${result.skippedRunning} 个运行中的 helper agent。`
                : `已清理 ${result.cleared} 个 helper agent。`,
            ),
          ],
        };
      }

      return {
        handled: true,
        messages: [message("error", "未知的 /debug helper-agent 子命令。")],
      };
    }

    if (subcommand === "legacy") {
      const action = args[0];
      if (action !== "clear") {
        return {
          handled: true,
          messages: [message("error", "用法：/debug legacy clear")],
        };
      }
      const result = await this.deps.clearLegacyAgents();
      const suffix: string[] = [];
      if (result.skippedRunning > 0) {
        suffix.push(`跳过 ${result.skippedRunning} 个运行中的 legacy agent`);
      }
      if (result.skippedActive > 0) {
        suffix.push(`跳过 ${result.skippedActive} 个当前激活的 legacy agent`);
      }
      return {
        handled: true,
        messages: [
          message(
            "info",
            suffix.length > 0
              ? `已清理 ${result.cleared} 个 legacy agent，${suffix.join("，")}。`
              : `已清理 ${result.cleared} 个 legacy agent。`,
          ),
        ],
      };
    }

    if (subcommand === "ui-context") {
      const action = args[0] ?? "status";
      if (action === "status") {
        const status = await this.deps.getDebugStatus();
        return {
          handled: true,
          messages: [
            message(
              "info",
              `ui-context: ${status.uiContextEnabled ? "on" : "off"}`,
            ),
          ],
        };
      }
      if (action !== "on" && action !== "off") {
        return {
          handled: true,
          messages: [message("error", "用法：/debug ui-context <on|off>")],
        };
      }
      await this.deps.setUiContextEnabled(action === "on");
      return {
        handled: true,
        messages: [message("info", `ui-context 已切换为 ${action}。`)],
      };
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /debug 子命令。")],
    };
  }

  private async handleSkills(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    const skills = this.deps.getAvailableSkills();
    if (!subcommand || subcommand === "list") {
      return {
        handled: true,
        messages: [
          message(
            "info",
            skills.length === 0
              ? "当前没有可用 skills。"
              : skills
                  .map((skill) => `${skill.id} | ${skill.description}`)
                  .join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "show") {
      const key = args[0];
      const skill = skills.find((item) => item.id === key || item.name === key);
      return {
        handled: true,
        messages: [
          message(
            skill ? "info" : "error",
            skill
              ? [
                  `id: ${skill.id}`,
                  `name: ${skill.name}`,
                  `description: ${skill.description}`,
                  `path: ${skill.filePath}`,
                  "说明：不需要手动激活，模型会在合适时自动使用。",
                ].join("\n")
              : `未找到 skill：${key}`,
          ),
        ],
      };
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /skills 子命令。")],
    };
  }

  private async handleAgent(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (!subcommand || subcommand === "status") {
      const agentId = args[0];
      const agent = await this.deps.getAgentStatus(agentId);
      return {
        handled: true,
        messages: [message("info", formatAgent(agent))],
      };
    }

    if (subcommand === "list") {
      const agents = await this.deps.listAgents();
      return {
        handled: true,
        messages: [
          message(
            "info",
            agents.length === 0
              ? "当前没有 agent。"
              : agents.map((agent) => formatAgent(agent)).join("\n\n"),
          ),
        ],
      };
    }

    if (subcommand === "spawn") {
      const name = args.find((arg) => !arg.startsWith("--"));
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/agent spawn <name> [--task|--interactive]")],
        };
      }
      const kind: AgentKind = args.includes("--task") ? "task" : "interactive";
      const agent = await this.deps.spawnAgent(name, kind);
      return {
        handled: true,
        messages: [message("info", `已创建 agent ${agent.id} (${agent.name}, ${agent.kind})`)],
      };
    }

    if (subcommand === "switch") {
      const agentId = args[0];
      if (!agentId) {
        return {
          handled: true,
          messages: [message("error", "用法：/agent switch <agentId|name>")],
        };
      }
      const agent = await this.deps.switchAgent(agentId);
      return {
        handled: true,
        messages: [message("info", `已切换到 agent ${agent.id} (${agent.name})`)],
      };
    }

    if (subcommand === "next") {
      const agent = await this.deps.switchAgentRelative(1);
      return {
        handled: true,
        messages: [message("info", `已切换到下一个 agent ${agent.id} (${agent.name})`)],
      };
    }

    if (subcommand === "prev") {
      const agent = await this.deps.switchAgentRelative(-1);
      return {
        handled: true,
        messages: [message("info", `已切换到上一个 agent ${agent.id} (${agent.name})`)],
      };
    }

    if (subcommand === "close") {
      const agentId = args[0];
      if (!agentId) {
        return {
          handled: true,
          messages: [message("error", "用法：/agent close <agentId|name>")],
        };
      }
      await this.deps.closeAgent(agentId);
      return {
        handled: true,
        messages: [message("info", `已关闭 agent ${agentId}`)],
      };
    }

    if (subcommand === "interrupt") {
      await this.deps.interruptAgent();
      return {
        handled: true,
        messages: [message("info", "已发送中断信号。")],
      };
    }

    if (subcommand === "resume") {
      await this.deps.resumeAgent();
      return {
        handled: true,
        messages: [message("info", "已恢复当前 agent。")],
      };
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /agent 子命令。")],
    };
  }

  private async handleSession(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (!subcommand || subcommand === "status") {
      const ref = await this.deps.getSessionGraphStatus();
      return {
        handled: true,
        messages: [
          message(
            "info",
            [
              `session: ${this.deps.getSessionId()}`,
              `agent: ${this.deps.getActiveAgentId?.() ?? this.deps.getActiveHeadId()}`,
              `head: ${this.deps.getActiveHeadId()}`,
              `ref: ${ref.label}`,
              `dirty: ${ref.dirty}`,
              `writerLease: ${ref.writerLeaseBranch ?? "none"}`,
            ].join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "list") {
      const refs = await this.deps.listSessionRefs();
      const lines = [
        ...refs.branches.map((branch) =>
          `${branch.current ? "*" : " "} ${branch.name} -> ${branch.targetNodeId}`,
        ),
        ...refs.tags.map((tag) =>
          `${tag.current ? "*" : " "} ${tag.name} -> ${tag.targetNodeId}`,
        ),
      ];
      return {
        handled: true,
        messages: [message("info", lines.join("\n"))],
      };
    }

    if (subcommand === "compact") {
      const result = await this.deps.compactSession();
      return {
        handled: true,
        messages: [
          message(
            "info",
            result.compacted
              ? [
                  `已完成 compact：before=${result.beforeTokens} after=${result.afterTokens}`,
                  `压缩分组=${result.removedGroups} | 保留分组=${result.keptGroups}`,
                  `summaryAgent=${result.agentId ?? "N/A"}`,
                ].join("\n")
              : "当前上下文不足以 compact，已跳过。",
          ),
        ],
      };
    }

    if (subcommand === "log") {
      const limitArg = args.find((arg) => arg.startsWith("--limit="));
      const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 20;
      const log = await this.deps.listSessionLog(limit);
      return {
        handled: true,
        messages: [
          message(
            "info",
            log
              .map((entry) =>
                `${entry.id} | ${entry.kind} | refs=${entry.refs.join(",")} | ${entry.summaryTitle ?? ""}`,
              )
              .join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "branch") {
      const name = args[0];
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/session branch <name>")],
        };
      }
      const ref = await this.deps.createSessionBranch(name);
      return {
        handled: true,
        messages: [message("info", `已创建分支 ${name}，当前 ref=${ref.label}`)],
      };
    }

    if (subcommand === "fork") {
      const name = args[0];
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/session fork <name>")],
        };
      }
      const ref = await this.deps.forkSessionBranch(name);
      return {
        handled: true,
        messages: [message("info", `已 fork 到分支 ${name}，当前 ref=${ref.label}`)],
      };
    }

    if (subcommand === "checkout") {
      const refName = args[0];
      if (!refName) {
        return {
          handled: true,
          messages: [message("error", "用法：/session checkout <ref>")],
        };
      }
      const result = await this.deps.checkoutSessionRef(refName);
      return {
        handled: true,
        messages: [message("info", result.message)],
      };
    }

    if (subcommand === "tag") {
      const name = args[0];
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/session tag <name>")],
        };
      }
      const ref = await this.deps.createSessionTag(name);
      return {
        handled: true,
        messages: [message("info", `已创建 tag ${name}，当前 ref=${ref.label}`)],
      };
    }

    if (subcommand === "merge") {
      const refName = args[0];
      if (!refName) {
        return {
          handled: true,
          messages: [message("error", "用法：/session merge <sourceRef>")],
        };
      }
      const ref = await this.deps.mergeSessionRef(refName);
      return {
        handled: true,
        messages: [message("info", `已 merge ${refName}，当前 ref=${ref.label}`)],
      };
    }

    if (subcommand === "head") {
      return this.handleSessionHead(args[0], args.slice(1));
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /session 子命令。")],
    };
  }

  private async handleSessionHead(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (!subcommand || subcommand === "status") {
      const ref = await this.deps.getSessionGraphStatus();
      return {
        handled: true,
        messages: [message("info", `active head=${ref.workingHeadId} | ${ref.label}`)],
      };
    }

    if (subcommand === "list") {
      const heads = await this.deps.listSessionHeads();
      return {
        handled: true,
        messages: [
          message(
            "info",
            heads.heads
              .map((head) =>
                `${head.active ? "*" : " "} ${head.id} | ${head.name} | ${head.attachmentLabel} | status=${head.status}`,
              )
              .join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "fork") {
      const name = args[0];
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/session head fork <name>")],
        };
      }
      const ref = await this.deps.forkSessionHead(name);
      return {
        handled: true,
        messages: [message("info", `已创建 working head ${name}，ref=${ref.label}`)],
      };
    }

    if (subcommand === "switch") {
      const headId = args[0];
      if (!headId) {
        return {
          handled: true,
          messages: [message("error", "用法：/session head switch <headId>")],
        };
      }
      const ref = await this.deps.switchSessionHead(headId);
      return {
        handled: true,
        messages: [message("info", `已切换 working head ${headId}，ref=${ref.label}`)],
      };
    }

    if (subcommand === "attach") {
      const [headId, refName] = args;
      if (!headId || !refName) {
        return {
          handled: true,
          messages: [message("error", "用法：/session head attach <headId> <ref>")],
        };
      }
      const ref = await this.deps.attachSessionHead(headId, refName);
      return {
        handled: true,
        messages: [message("info", `已 attach ${headId} 到 ${ref.label}`)],
      };
    }

    if (subcommand === "detach") {
      const headId = args[0];
      if (!headId) {
        return {
          handled: true,
          messages: [message("error", "用法：/session head detach <headId>")],
        };
      }
      const ref = await this.deps.detachSessionHead(headId);
      return {
        handled: true,
        messages: [message("info", `已 detach ${headId}，当前=${ref.label}`)],
      };
    }

    if (subcommand === "merge") {
      const headId = args[0];
      if (!headId) {
        return {
          handled: true,
          messages: [message("error", "用法：/session head merge <sourceHeadId>")],
        };
      }
      const ref = await this.deps.mergeSessionHead(headId);
      return {
        handled: true,
        messages: [message("info", `已 merge ${headId}，当前=${ref.label}`)],
      };
    }

    if (subcommand === "close") {
      const headId = args[0];
      if (!headId) {
        return {
          handled: true,
          messages: [message("error", "用法：/session head close <headId>")],
        };
      }
      await this.deps.closeSessionHead(headId);
      return {
        handled: true,
        messages: [message("info", `已关闭 working head ${headId}`)],
      };
    }

    return {
      handled: true,
      messages: [message("error", "未知的 /session head 子命令。")],
    };
  }
}
