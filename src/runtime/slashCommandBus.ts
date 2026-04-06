import type {
  ApprovalMode,
  MemoryRecord,
  ModelProvider,
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
  getShellCwd: () => string;
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
  setModelProvider: (provider: ModelProvider) => Promise<void>;
  setModelName: (model: string) => Promise<void>;
  setModelApiKey: (apiKey: string) => Promise<void>;
  listMemory: (limit?: number) => Promise<MemoryRecord[]>;
  saveMemory: (input: {
    content: string;
    title?: string;
    tags?: string[];
    scope?: "project" | "global";
  }) => Promise<MemoryRecord>;
  showMemory: (id: string) => Promise<MemoryRecord | undefined>;
  interruptAgent: () => Promise<void>;
  resumeAgent: () => Promise<void>;
  getSessionGraphStatus: () => Promise<SessionRefInfo>;
  listSessionRefs: () => Promise<SessionListView>;
  listSessionLog: (limit?: number) => Promise<SessionLogEntry[]>;
  createSessionBranch: (name: string) => Promise<SessionRefInfo>;
  forkSessionBranch: (name: string) => Promise<SessionRefInfo>;
  checkoutSessionRef: (ref: string) => Promise<SessionCheckoutResultLike>;
  createSessionTag: (name: string) => Promise<SessionRefInfo>;
  mergeSessionRef: (ref: string) => Promise<SessionRefInfo>;
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
  return matches.map((token) => token.replace(/^["']|["']$/g, ""));
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
    "/memory save [--global] [--tags=a,b] [--title=标题] <内容>",
    "/memory list",
    "/memory show <id>",
    "/skills list",
    "/skills show <name|id>",
    "/session status",
    "/session list",
    "/session log [--limit=N]",
    "/session branch <name>",
    "/session fork <name>",
    "/session checkout <ref>",
    "/session tag <name>",
    "/session merge <sourceRef>",
    "/agent status",
    "/agent interrupt",
    "/agent resume",
    "/clear",
    "/exit",
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
        case "memory":
          return this.handleMemory(subcommand, rest);
        case "skills":
          return this.handleSkills(subcommand, rest);
        case "session":
          return this.handleSession(subcommand, rest);
        case "agent":
          return this.handleAgent(subcommand);
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
          message(
            "info",
            `provider 已切换为 ${provider}，并已写入项目 .agent/config.json。`,
          ),
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
        messages: [
          message(
            "info",
            `model 已切换为 ${modelName}，并已写入项目 .agent/config.json。`,
          ),
        ],
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
        messages: [
          message(
            "info",
            "API key 已更新，并已写入全局 ~/.agent/config.json。",
          ),
        ],
      };
    }

    return {
      handled: true,
      messages: [
        message(
          "error",
          "用法：/model status | /model provider <openai|openrouter> | /model name <model> | /model apikey <key>",
        ),
      ],
    };
  }

  private async handleTool(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (subcommand === "status") {
      return {
        handled: true,
        messages: [
          message(
            "info",
            [
              `session: ${this.deps.getSessionId()}`,
              `shell cwd: ${this.deps.getShellCwd()}`,
              `approval mode: ${this.deps.getApprovalMode()}`,
            ].join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "confirm") {
      const mode = args[0] as ApprovalMode | undefined;
      if (!mode) {
        return {
          handled: true,
          messages: [
            message(
              "info",
              `当前审批模式：${this.deps.getApprovalMode()}。可设置为 always、risky、never。`,
            ),
          ],
        };
      }

      if (!["always", "risky", "never"].includes(mode)) {
        return {
          handled: true,
          messages: [message("error", "审批模式必须是 always、risky 或 never。")],
        };
      }

      await this.deps.setApprovalMode(mode);
      return {
        handled: true,
        messages: [message("info", `审批模式已切换为 ${mode}。`)],
      };
    }

    return {
      handled: true,
      messages: [message("error", "用法：/tool status 或 /tool confirm <mode>")],
    };
  }

  private async handleMemory(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (subcommand === "list") {
      const records = await this.deps.listMemory(10);
      const content =
        records.length === 0
          ? "当前没有保存任何长期记忆。"
          : records
              .map((record) => `${record.id} | ${record.title} | ${record.scope}`)
              .join("\n");

      return {
        handled: true,
        messages: [message("info", content)],
      };
    }

    if (subcommand === "show") {
      const id = args[0];
      if (!id) {
        return {
          handled: true,
          messages: [message("error", "用法：/memory show <id>")],
        };
      }

      const record = await this.deps.showMemory(id);
      if (!record) {
        return {
          handled: true,
          messages: [message("error", `未找到记忆：${id}`)],
        };
      }

      return {
        handled: true,
        messages: [
          message(
            "info",
            [`${record.title} (${record.scope})`, record.content].join("\n\n"),
          ),
        ],
      };
    }

    if (subcommand === "save") {
      let scope: "project" | "global" = "project";
      let title: string | undefined;
      let tags: string[] = [];
      const contentParts: string[] = [];

      for (const arg of args) {
        if (arg === "--global") {
          scope = "global";
          continue;
        }
        if (arg.startsWith("--title=")) {
          title = arg.slice("--title=".length).trim();
          continue;
        }
        if (arg.startsWith("--tags=")) {
          tags = arg
            .slice("--tags=".length)
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
          continue;
        }
        contentParts.push(arg);
      }

      const content = contentParts.join(" ").trim();
      if (!content) {
        return {
          handled: true,
          messages: [
            message(
              "error",
              "用法：/memory save [--global] [--tags=a,b] [--title=标题] <内容>",
            ),
          ],
        };
      }

      const record = await this.deps.saveMemory({
        content,
        title,
        tags,
        scope,
      });
      return {
        handled: true,
        messages: [message("info", `记忆已保存：${record.id} (${record.title})`)],
      };
    }

    return {
      handled: true,
      messages: [
        message("error", "用法：/memory list | /memory show <id> | /memory save ..."),
      ],
    };
  }

  private async handleSkills(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (subcommand === "list") {
      const skills = this.deps.getAvailableSkills();
      const content =
        skills.length === 0
          ? "当前没有发现任何 Skill。"
          : skills
              .map((skill) => {
                return `- ${skill.id} | ${skill.name} | ${skill.scope}`;
              })
              .join("\n");

      return {
        handled: true,
        messages: [message("info", content)],
      };
    }

    if (subcommand === "show") {
      const identifier = args[0];
      if (!identifier) {
        return {
          handled: true,
          messages: [message("error", "用法：/skills show <name|id>")],
        };
      }
      const skill = this.deps
        .getAvailableSkills()
        .find((item) => item.id === identifier || item.name === identifier);
      if (!skill) {
        return {
          handled: true,
          messages: [message("error", `未找到 Skill：${identifier}`)],
        };
      }

      return {
        handled: true,
        messages: [
          message(
            "info",
            [
              `${skill.id}`,
              `description: ${skill.description}`,
              `path: ${skill.directoryPath}`,
              "使用方式：官方模型下不需要手动激活。Agent 会在上下文中看到全部 Skill 元信息，需要时请通过 shell 直接读取该目录中的 SKILL.md、scripts、references、assets 等内容。",
            ].join("\n\n"),
          ),
        ],
      };
    }

    return {
      handled: true,
      messages: [
        message("error", "用法：/skills list | /skills show <id>"),
      ],
    };
  }

  private async handleAgent(subcommand?: string): Promise<SlashCommandResult> {
    if (subcommand === "status") {
      return {
        handled: true,
        messages: [message("info", this.deps.getStatusLine())],
      };
    }

    if (subcommand === "interrupt") {
      await this.deps.interruptAgent();
      return {
        handled: true,
        messages: [message("info", "已请求中断当前 Agent 执行。")],
      };
    }

    if (subcommand === "resume") {
      await this.deps.resumeAgent();
      return {
        handled: true,
        messages: [message("info", "已请求恢复当前 Agent 执行。")],
      };
    }

    return {
      handled: true,
      messages: [message("error", "用法：/agent status | /agent interrupt | /agent resume")],
    };
  }

  private async handleSession(
    subcommand?: string,
    args: string[] = [],
  ): Promise<SlashCommandResult> {
    if (!subcommand || subcommand === "status") {
      const status = await this.deps.getSessionGraphStatus();
      return {
        handled: true,
        messages: [
          message(
            "info",
            [
              `ref: ${status.label}`,
              `head: ${status.headNodeId}`,
              `working session: ${status.workingSessionId}`,
              `dirty: ${status.dirty ? "yes" : "no"}`,
            ].join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "list") {
      const refs = await this.deps.listSessionRefs();
      return {
        handled: true,
        messages: [
          message(
            "info",
            [
              "branches:",
              refs.branches.length === 0
                ? "(empty)"
                : refs.branches
                    .map((item) => {
                      return `${item.current ? "*" : " "} ${item.name} -> ${item.targetNodeId}`;
                    })
                    .join("\n"),
              "",
              "tags:",
              refs.tags.length === 0
                ? "(empty)"
                : refs.tags
                    .map((item) => {
                      return `${item.current ? "*" : " "} ${item.name} -> ${item.targetNodeId}`;
                    })
                    .join("\n"),
            ].join("\n"),
          ),
        ],
      };
    }

    if (subcommand === "log") {
      const limitArg = args.find((arg) => arg.startsWith("--limit="));
      const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 10;
      const entries = await this.deps.listSessionLog(
        Number.isFinite(limit) && limit > 0 ? limit : 10,
      );
      return {
        handled: true,
        messages: [
          message(
            "info",
            entries.length === 0
              ? "当前没有 session nodes。"
              : entries
                  .map((entry) => {
                    return [
                      `${entry.id} | ${entry.kind} | parents=${entry.parentNodeIds.join(",") || "(root)"}`,
                      `refs=${entry.refs.join(",") || "(none)"} | summary=${entry.summaryTitle ?? "无"}`,
                    ].join("\n");
                  })
                  .join("\n\n"),
          ),
        ],
      };
    }

    if (subcommand === "branch") {
      const name = args[0]?.trim();
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/session branch <name>")],
        };
      }
      const ref = await this.deps.createSessionBranch(name);
      return {
        handled: true,
        messages: [message("info", `已创建分支 ${name}。当前 ref: ${ref.label}`)],
      };
    }

    if (subcommand === "fork") {
      const name = args[0]?.trim();
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/session fork <name>")],
        };
      }
      const ref = await this.deps.forkSessionBranch(name);
      return {
        handled: true,
        messages: [message("info", `已 fork 到分支 ${name}，当前 ref: ${ref.label}`)],
      };
    }

    if (subcommand === "checkout") {
      const refName = args[0]?.trim();
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
      const name = args[0]?.trim();
      if (!name) {
        return {
          handled: true,
          messages: [message("error", "用法：/session tag <name>")],
        };
      }
      const ref = await this.deps.createSessionTag(name);
      return {
        handled: true,
        messages: [message("info", `已创建 tag ${name}，当前 ref: ${ref.label}`)],
      };
    }

    if (subcommand === "merge") {
      const sourceRef = args[0]?.trim();
      if (!sourceRef) {
        return {
          handled: true,
          messages: [message("error", "用法：/session merge <sourceRef>")],
        };
      }
      const ref = await this.deps.mergeSessionRef(sourceRef);
      return {
        handled: true,
        messages: [message("info", `已 merge ${sourceRef}，当前 ref: ${ref.label}`)],
      };
    }

    return {
      handled: true,
      messages: [
        message(
          "error",
          "用法：/session status | /session list | /session log [--limit=N] | /session branch <name> | /session fork <name> | /session checkout <ref> | /session tag <name> | /session merge <sourceRef>",
        ),
      ],
    };
  }
}
