import type {
  AgentKind,
  AgentViewState,
  ApprovalMode,
  CommandMessage,
  CommandRequest,
  CommandResult,
  MemoryRecord,
  ModelProvider,
  PendingApprovalCheckpoint,
  SessionCommitListView,
  SessionHeadListView,
  SessionListView,
  SessionLogEntry,
  SessionRefInfo,
  SkillManifest,
  UIMessage,
} from "../types.js";
import { formatAgent } from "./common.js";

interface SessionCheckoutResultLike {
  ref: SessionRefInfo;
  message: string;
}

interface SettledCommandRunResult {
  settled: "completed" | "approval_required" | "interrupted" | "error";
  agent: AgentViewState;
  checkpoint?: PendingApprovalCheckpoint;
  uiMessages: ReadonlyArray<UIMessage>;
}

export interface CommandServiceDependencies {
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
  listSessionCommits: (limit?: number) => Promise<SessionCommitListView>;
  listSessionGraphLog: (limit?: number) => Promise<SessionLogEntry[]>;
  listSessionLog: (limit?: number) => Promise<SessionLogEntry[]>;
  compactSession: () => Promise<{
    compacted: boolean;
    agentId?: string;
    beforeTokens: number;
    afterTokens: number;
    keptGroups: number;
    removedGroups: number;
  }>;
  commitSession: (message: string) => Promise<{
    id: string;
    message: string;
    nodeId: string;
    headId: string;
    sessionId: string;
    createdAt: string;
  }>;
  createSessionBranch: (name: string) => Promise<SessionRefInfo>;
  switchSessionCreateBranch: (name: string) => Promise<SessionRefInfo>;
  switchSessionRef: (ref: string) => Promise<SessionCheckoutResultLike>;
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
  clearUi: () => Promise<void>;
  runPrompt: (
    prompt: string,
    input?: {
      agentId?: string;
      approvalMode?: "interactive" | "checkpoint";
      modelInputAppendix?: string;
    },
  ) => Promise<SettledCommandRunResult>;
  getPendingApproval: (input?: {
    checkpointId?: string;
    agentId?: string;
    headId?: string;
  }) => Promise<PendingApprovalCheckpoint | undefined>;
  resolvePendingApproval: (
    approved: boolean,
    input?: {
      checkpointId?: string;
      agentId?: string;
      headId?: string;
    },
  ) => Promise<SettledCommandRunResult>;
}

function info(text: string, title?: string): CommandMessage {
  return {
    level: "info",
    text,
    title,
  };
}

function error(text: string, title?: string): CommandMessage {
  return {
    level: "error",
    text,
    title,
  };
}

function success(
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

function validationError(code: string, text: string): CommandResult {
  return {
    status: "validation_error",
    code,
    exitCode: 2,
    messages: [error(text)],
  };
}

function runtimeErrorResult(code: string, text: string, payload?: unknown): CommandResult {
  return {
    status: "runtime_error",
    code,
    exitCode: 1,
    messages: [error(text)],
    payload,
  };
}

function approvalRequired(
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

export class CommandService {
  public constructor(private readonly deps: CommandServiceDependencies) {}

  public async execute(request: CommandRequest): Promise<CommandResult> {
    try {
      switch (request.domain) {
        case "run":
          return this.handleRun(request);
        case "model":
          return this.handleModel(request);
        case "tool":
          return this.handleTool(request);
        case "hook":
          return this.handleHook(request);
        case "debug":
          return this.handleDebug(request);
        case "memory":
          return this.handleMemory(request);
        case "skills":
          return this.handleSkills(request);
        case "agent":
          return this.handleAgent(request);
        case "session":
          return this.handleSession(request);
        case "approval":
          return this.handleApproval(request);
        case "clear":
          await this.deps.clearUi();
          return success("clear.success", [info("已清空当前 agent 的 UI 消息。")]);
        default:
          return runtimeErrorResult("command.unsupported", "未知命令。");
      }
    } catch (cause) {
      return runtimeErrorResult(
        "command.runtime_error",
        cause instanceof Error ? cause.message : "命令执行失败。",
      );
    }
  }

  private async handleRun(
    request: Extract<CommandRequest, { domain: "run" }>,
  ): Promise<CommandResult> {
    if (!request.prompt.trim()) {
      return validationError("run.prompt_required", "用法：run <prompt>");
    }
    const result = await this.deps.runPrompt(request.prompt, {
      agentId: request.agentId,
      approvalMode: "checkpoint",
      modelInputAppendix: request.modelInputAppendix,
    });
    if (result.settled === "approval_required" && result.checkpoint) {
      return approvalRequired(result.checkpoint, result.uiMessages);
    }
    if (result.settled === "error") {
      return runtimeErrorResult("run.agent_error", result.agent.detail, {
        agent: result.agent,
        uiMessages: result.uiMessages,
      });
    }
    if (result.settled === "interrupted") {
      return runtimeErrorResult("run.interrupted", result.agent.detail, {
        agent: result.agent,
        uiMessages: result.uiMessages,
      });
    }
    return success("run.completed", [], {
      agent: result.agent,
      uiMessages: result.uiMessages,
    });
  }

  private async handleModel(
    request: Extract<CommandRequest, { domain: "model" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const status = this.deps.getModelStatus();
      return success(
        "model.status",
        [
          info(
            [
              `provider: ${status.provider}`,
              `model: ${status.model}`,
              `baseUrl: ${status.baseUrl}`,
              `apiKey: ${status.apiKeyMasked ?? "未配置"}`,
              "说明：provider/model 会写入项目 .agent/config.json，apikey 会写入全局 ~/.agent/config.json。",
            ].join("\n"),
          ),
        ],
        status,
      );
    }
    if (request.action === "provider") {
      if (request.provider !== "openai" && request.provider !== "openrouter") {
        return validationError("model.provider_usage", "用法：model provider <openai|openrouter>");
      }
      await this.deps.setModelProvider(request.provider);
      return success("model.provider_updated", [info(`provider 已切换为 ${request.provider}。`)]);
    }
    if (request.action === "name") {
      const modelName = request.model?.trim();
      if (!modelName) {
        return validationError("model.name_usage", "用法：model name <model>");
      }
      await this.deps.setModelName(modelName);
      return success("model.name_updated", [info(`model 已切换为 ${modelName}。`)]);
    }
    if (request.action === "apikey") {
      const apiKey = request.apiKey?.trim();
      if (!apiKey) {
        return validationError("model.apikey_usage", "用法：model apikey <key>");
      }
      await this.deps.setModelApiKey(apiKey);
      return success("model.apikey_updated", [info("API key 已更新。")]);
    }
    return runtimeErrorResult("model.unknown_action", "未知的 model 子命令。");
  }

  private async handleTool(
    request: Extract<CommandRequest, { domain: "tool" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      return success(
        "tool.status",
        [
          info(
            [
              `approvalMode: ${this.deps.getApprovalMode()}`,
              `shellCwd: ${this.deps.getShellCwd()}`,
            ].join("\n"),
          ),
        ],
      );
    }
    if (!request.mode) {
      return validationError("tool.confirm_usage", "用法：tool confirm <always|risky|never>");
    }
    await this.deps.setApprovalMode(request.mode);
    return success("tool.confirm_updated", [info(`approval mode 已切换为 ${request.mode}。`)]);
  }

  private async handleHook(
    request: Extract<CommandRequest, { domain: "hook" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const status = this.deps.getHookStatus();
      return success(
        "hook.status",
        [
          info(
            [
              `fetch-memory: ${status.fetchMemory ? "on" : "off"}`,
              `save-memory: ${status.saveMemory ? "on" : "off"}`,
              `auto-compact: ${status.autoCompact ? "on" : "off"}`,
            ].join("\n"),
          ),
        ],
        status,
      );
    }
    if (request.enabled === undefined) {
      const usage =
        request.action === "fetch-memory"
          ? "hook fetch-memory <on|off>"
          : request.action === "save-memory"
            ? "hook save-memory <on|off>"
            : "hook auto-compact <on|off>";
      return validationError("hook.toggle_usage", `用法：${usage}`);
    }
    const mode = request.enabled ? "on" : "off";
    if (request.action === "fetch-memory") {
      await this.deps.setFetchMemoryHookEnabled(request.enabled);
      return success("hook.updated", [info(`fetch-memory hook 已切换为 ${mode}。`)]);
    } else if (request.action === "save-memory") {
      await this.deps.setSaveMemoryHookEnabled(request.enabled);
      return success("hook.updated", [info(`save-memory hook 已切换为 ${mode}。`)]);
    } else {
      await this.deps.setAutoCompactHookEnabled(request.enabled);
      return success("hook.updated", [info(`auto-compact hook 已切换为 ${mode}。`)]);
    }
  }

  private async handleDebug(
    request: Extract<CommandRequest, { domain: "debug" }>,
  ): Promise<CommandResult> {
    if (request.action === "helper-agent-status") {
      const status = await this.deps.getDebugStatus();
      return success(
        "debug.helper_agent.status",
        [
          info(
            [
              `helper-agent autocleanup: ${status.helperAgentAutoCleanup ? "on" : "off"}`,
              `helper-agent count: ${status.helperAgentCount}`,
              `legacy-agent count: ${status.legacyAgentCount}`,
              `ui-context: ${status.uiContextEnabled ? "on" : "off"}`,
            ].join("\n"),
          ),
        ],
        status,
      );
    }
    if (request.action === "helper-agent-autocleanup") {
      if (request.enabled === undefined) {
        return validationError(
          "debug.helper_agent.autocleanup_usage",
          "用法：debug helper-agent autocleanup <on|off>",
        );
      }
      await this.deps.setHelperAgentAutoCleanupEnabled(request.enabled);
      return success(
        "debug.helper_agent.autocleanup_updated",
        [info(`helper-agent autocleanup 已切换为 ${request.enabled ? "on" : "off"}。`)],
      );
    }
    if (request.action === "helper-agent-clear") {
      const result = await this.deps.clearHelperAgents();
      return success(
        "debug.helper_agent.cleared",
        [
          info(
            result.skippedRunning > 0
              ? `已清理 ${result.cleared} 个 helper agent，跳过 ${result.skippedRunning} 个运行中的 helper agent。`
              : `已清理 ${result.cleared} 个 helper agent。`,
          ),
        ],
        result,
      );
    }
    if (request.action === "legacy-clear") {
      const result = await this.deps.clearLegacyAgents();
      const suffix: string[] = [];
      if (result.skippedRunning > 0) {
        suffix.push(`跳过 ${result.skippedRunning} 个运行中的 legacy agent`);
      }
      if (result.skippedActive > 0) {
        suffix.push(`跳过 ${result.skippedActive} 个当前激活的 legacy agent`);
      }
      return success(
        "debug.legacy.cleared",
        [
          info(
            suffix.length > 0
              ? `已清理 ${result.cleared} 个 legacy agent，${suffix.join("，")}。`
              : `已清理 ${result.cleared} 个 legacy agent。`,
          ),
        ],
        result,
      );
    }
    if (request.action === "ui-context-status") {
      const status = await this.deps.getDebugStatus();
      return success(
        "debug.ui_context.status",
        [info(`ui-context: ${status.uiContextEnabled ? "on" : "off"}`)],
        status,
      );
    }
    if (request.enabled === undefined) {
      return validationError("debug.ui_context_usage", "用法：debug ui-context <on|off>");
    }
    await this.deps.setUiContextEnabled(request.enabled);
    return success(
      "debug.ui_context.updated",
      [info(`ui-context 已切换为 ${request.enabled ? "on" : "off"}。`)],
    );
  }

  private async handleMemory(
    request: Extract<CommandRequest, { domain: "memory" }>,
  ): Promise<CommandResult> {
    if (request.action === "list") {
      const records = await this.deps.listMemory();
      return success(
        "memory.list",
        [
          info(
            records.length === 0
              ? "当前没有 memory。"
              : records
                  .map((record) => `${record.name} | ${record.scope} | ${record.description}`)
                  .join("\n"),
          ),
        ],
        {
          records,
        },
      );
    }
    if (request.action === "show") {
      if (!request.name) {
        return validationError("memory.show_usage", "用法：memory show <name>");
      }
      const record = await this.deps.showMemory(request.name);
      return success(
        "memory.show",
        [
          record
            ? info(
                [
                  `id: ${record.id}`,
                  `name: ${record.name}`,
                  `description: ${record.description}`,
                  `scope: ${record.scope}`,
                  `directory: ${record.directoryPath}`,
                  `path: ${record.path}`,
                  "",
                  record.content,
                ].join("\n"),
              )
            : error(`未找到 memory：${request.name}`),
        ],
        {
          record,
        },
      );
    }
    if (!request.name || !request.description || !request.content) {
      return validationError(
        "memory.save_usage",
        "用法：memory save [--global] --name=<name> --description=<说明> <内容>",
      );
    }
    const record = await this.deps.saveMemory({
      name: request.name,
      description: request.description,
      content: request.content,
      scope: request.scope,
    });
    return success("memory.saved", [info(`已保存 memory：${record.name}`)], {
      record,
    });
  }

  private async handleSkills(
    request: Extract<CommandRequest, { domain: "skills" }>,
  ): Promise<CommandResult> {
    const skills = this.deps.getAvailableSkills();
    if (request.action === "list") {
      return success(
        "skills.list",
        [
          info(
            skills.length === 0
              ? "当前没有可用 skills。"
              : skills.map((skill) => `${skill.id} | ${skill.description}`).join("\n"),
          ),
        ],
        {
          skills,
        },
      );
    }

    const skill = skills.find((item) => item.id === request.key || item.name === request.key);
    return success(
      "skills.show",
      [
        skill
          ? info(
              [
                `id: ${skill.id}`,
                `name: ${skill.name}`,
                `description: ${skill.description}`,
                `path: ${skill.filePath}`,
                "说明：不需要手动激活，模型会在合适时自动使用。",
              ].join("\n"),
            )
          : error(`未找到 skill：${request.key ?? ""}`),
      ],
      {
        skill,
      },
    );
  }

  private async handleAgent(
    request: Extract<CommandRequest, { domain: "agent" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const agent = await this.deps.getAgentStatus(request.agentId);
      return success("agent.status", [info(formatAgent(agent))], {
        agent,
      });
    }
    if (request.action === "list") {
      const agents = await this.deps.listAgents();
      return success(
        "agent.list",
        [
          info(
            agents.length === 0
              ? "当前没有 agent。"
              : agents.map((agent) => formatAgent(agent)).join("\n\n"),
          ),
        ],
        {
          agents,
        },
      );
    }
    if (request.action === "spawn") {
      if (!request.name) {
        return validationError("agent.spawn_usage", "用法：agent spawn <name> [--task|--interactive]");
      }
      const agent = await this.deps.spawnAgent(request.name, request.kind ?? "interactive");
      return success(
        "agent.spawned",
        [info(`已创建 agent ${agent.id} (${agent.name}, ${agent.kind})`)],
        {
          agent,
        },
      );
    }
    if (request.action === "switch") {
      if (!request.agentId) {
        return validationError("agent.switch_usage", "用法：agent switch <agentId|name>");
      }
      const agent = await this.deps.switchAgent(request.agentId);
      return success(
        "agent.switched",
        [info(`已切换到 agent ${agent.id} (${agent.name})`)],
        {
          agent,
        },
      );
    }
    if (request.action === "next" || request.action === "prev") {
      const agent = await this.deps.switchAgentRelative(request.action === "next" ? 1 : -1);
      return success(
        request.action === "next" ? "agent.next" : "agent.prev",
        [
          info(
            request.action === "next"
              ? `已切换到下一个 agent ${agent.id} (${agent.name})`
              : `已切换到上一个 agent ${agent.id} (${agent.name})`,
          ),
        ],
        {
          agent,
        },
      );
    }
    if (request.action === "close") {
      if (!request.agentId) {
        return validationError("agent.close_usage", "用法：agent close <agentId|name>");
      }
      const agent = await this.deps.closeAgent(request.agentId);
      return success("agent.closed", [info(`已关闭 agent ${request.agentId}`)], {
        agent,
      });
    }
    if (request.action === "interrupt") {
      await this.deps.interruptAgent();
      return success("agent.interrupted", [info("已发送中断信号。")]);
    }
    await this.deps.resumeAgent();
    return success("agent.resumed", [info("已恢复当前 agent。")]);
  }

  private async handleSession(
    request: Extract<CommandRequest, { domain: "session" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const ref = await this.deps.getSessionGraphStatus();
      return success(
        "session.status",
        [
          info(
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
        {
          ref,
        },
      );
    }
    if (request.action === "compact") {
      const result = await this.deps.compactSession();
      return success(
        "session.compacted",
        [
          info(
            result.compacted
              ? [
                  `已完成 compact：before=${result.beforeTokens} after=${result.afterTokens}`,
                  `压缩分组=${result.removedGroups} | 保留分组=${result.keptGroups}`,
                  `summaryAgent=${result.agentId ?? "N/A"}`,
                ].join("\n")
              : "当前上下文不足以 compact，已跳过。",
          ),
        ],
        result,
      );
    }
    if (request.action === "commit") {
      if (!request.message?.trim()) {
        return validationError("session.commit_usage", "用法：session commit -m \"<message>\"");
      }
      const commit = await this.deps.commitSession(request.message);
      return success(
        "session.commit_created",
        [
          info(
            [
              `已创建 commit ${commit.id}`,
              `message: ${commit.message}`,
              `node: ${commit.nodeId}`,
              `createdAt: ${commit.createdAt}`,
            ].join("\n"),
          ),
        ],
        commit,
      );
    }
    if (request.action === "log") {
      const commits = await this.deps.listSessionCommits(request.limit);
      return success(
        "session.log",
        [
          info(
            commits.commits.length > 0
              ? commits.commits
                  .map((entry) => `${entry.current ? "*" : " "} ${entry.id} | ${entry.message} | ${entry.nodeId} | ${entry.createdAt}`)
                  .join("\n")
              : "暂无 commit 记录。",
          ),
        ],
        commits,
      );
    }
    if (request.action === "graph-log") {
      const log = await this.deps.listSessionGraphLog(request.limit);
      return success(
        "session.graph_log",
        [
          info(
            log.length > 0
              ? log
                  .map((entry) => `${entry.id} | ${entry.kind} | refs=${entry.refs.join(",")} | ${entry.summaryTitle ?? ""}`)
                  .join("\n")
              : "暂无 session graph 节点。",
          ),
        ],
        {
          log,
        },
      );
    }
    if (request.action === "branch-list") {
      const refs = await this.deps.listSessionRefs();
      return success(
        "session.branch_list",
        [
          info(
            refs.branches.length > 0
              ? refs.branches
                  .map((branch) => `${branch.current ? "*" : " "} ${branch.name} -> ${branch.targetNodeId}`)
                  .join("\n")
              : "暂无 branch。",
          ),
        ],
        refs,
      );
    }
    if (request.action === "branch-create") {
      if (!request.name) {
        return validationError("session.branch_usage", "用法：session branch <name>");
      }
      const ref = await this.deps.createSessionBranch(request.name);
      return success("session.branch_created", [info(`已创建分支 ${request.name}，当前 ref=${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "switch-create-branch") {
      if (!request.name) {
        return validationError("session.switch_create_branch_usage", "用法：session switch -c <branch>");
      }
      const ref = await this.deps.switchSessionCreateBranch(request.name);
      return success("session.switch_create_branch", [info(`已创建并切换到分支 ${request.name}，当前 ref=${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "switch") {
      if (!request.ref) {
        return validationError("session.switch_usage", "用法：session switch <ref>");
      }
      const result = await this.deps.switchSessionRef(request.ref);
      return success("session.switched", [info(result.message)], result);
    }
    if (request.action === "tag-list") {
      const refs = await this.deps.listSessionRefs();
      return success(
        "session.tag_list",
        [
          info(
            refs.tags.length > 0
              ? refs.tags
                  .map((tag) => `${tag.current ? "*" : " "} ${tag.name} -> ${tag.targetNodeId}`)
                  .join("\n")
              : "暂无 tag。",
          ),
        ],
        refs,
      );
    }
    if (request.action === "tag-create") {
      if (!request.name) {
        return validationError("session.tag_usage", "用法：session tag <name>");
      }
      const ref = await this.deps.createSessionTag(request.name);
      return success("session.tag_created", [info(`已创建 tag ${request.name}，当前 ref=${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "merge") {
      if (!request.ref) {
        return validationError("session.merge_usage", "用法：session merge <sourceRef>");
      }
      const ref = await this.deps.mergeSessionRef(request.ref);
      return success("session.merged", [info(`已 merge ${request.ref}，当前 ref=${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "head-status") {
      const ref = await this.deps.getSessionGraphStatus();
      return success("session.head_status", [info(`active head=${ref.workingHeadId} | ${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "head-list") {
      const heads = await this.deps.listSessionHeads();
      return success(
        "session.head_list",
        [
          info(
            heads.heads
              .map((head) => `${head.active ? "*" : " "} ${head.id} | ${head.name} | ${head.attachmentLabel} | status=${head.status}`)
              .join("\n"),
          ),
        ],
        heads,
      );
    }
    if (request.action === "head-fork") {
      if (!request.name) {
        return validationError("session.head_fork_usage", "用法：session head fork <name>");
      }
      const ref = await this.deps.forkSessionHead(request.name);
      return success("session.head_forked", [info(`已创建 working head ${request.name}，ref=${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "head-switch") {
      if (!request.headId) {
        return validationError("session.head_switch_usage", "用法：session head switch <headId>");
      }
      const ref = await this.deps.switchSessionHead(request.headId);
      return success("session.head_switched", [info(`已切换 working head ${request.headId}，ref=${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "head-attach") {
      if (!request.headId || !request.ref) {
        return validationError("session.head_attach_usage", "用法：session head attach <headId> <ref>");
      }
      const ref = await this.deps.attachSessionHead(request.headId, request.ref);
      return success("session.head_attached", [info(`已 attach ${request.headId} 到 ${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "head-detach") {
      if (!request.headId) {
        return validationError("session.head_detach_usage", "用法：session head detach <headId>");
      }
      const ref = await this.deps.detachSessionHead(request.headId);
      return success("session.head_detached", [info(`已 detach ${request.headId}，当前=${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "head-merge") {
      if (!request.sourceHeadId) {
        return validationError("session.head_merge_usage", "用法：session head merge <sourceHeadId>");
      }
      const ref = await this.deps.mergeSessionHead(request.sourceHeadId);
      return success("session.head_merged", [info(`已 merge ${request.sourceHeadId}，当前=${ref.label}`)], {
        ref,
      });
    }
    if (request.action === "head-close") {
      if (!request.headId) {
        return validationError("session.head_close_usage", "用法：session head close <headId>");
      }
      const ref = await this.deps.closeSessionHead(request.headId);
      return success("session.head_closed", [info(`已关闭 working head ${request.headId}`)], {
        ref,
      });
    }
    return runtimeErrorResult("session.unknown_action", "未知的 session 子命令。");
  }

  private async handleApproval(
    request: Extract<CommandRequest, { domain: "approval" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const checkpoint = await this.deps.getPendingApproval({
        checkpointId: request.checkpointId,
        agentId: request.agentId,
        headId: request.headId,
      });
      return success(
        "approval.status",
        [
          checkpoint
            ? info(
                [
                  `checkpoint: ${checkpoint.checkpointId}`,
                  `agent: ${checkpoint.agentId}`,
                  `head: ${checkpoint.headId}`,
                  `session: ${checkpoint.sessionId}`,
                  `tool: ${checkpoint.toolCall.input.command}`,
                  `request: ${checkpoint.approvalRequest.id}`,
                ].join("\n"),
              )
            : info("当前没有待审批请求。"),
        ],
        {
          checkpoint,
        },
      );
    }

    const result = await this.deps.resolvePendingApproval(
      request.action === "approve",
      {
        checkpointId: request.checkpointId,
        agentId: request.agentId,
        headId: request.headId,
      },
    );
    if (result.settled === "approval_required" && result.checkpoint) {
      return approvalRequired(result.checkpoint, result.uiMessages);
    }
    if (result.settled === "error") {
      return runtimeErrorResult("approval.resume_error", result.agent.detail, {
        agent: result.agent,
        uiMessages: result.uiMessages,
      });
    }
    if (result.settled === "interrupted") {
      return runtimeErrorResult("approval.resume_interrupted", result.agent.detail, {
        agent: result.agent,
        uiMessages: result.uiMessages,
      });
    }
    return success(
      request.action === "approve" ? "approval.approved" : "approval.rejected",
      [
        info(request.action === "approve" ? "已批准并继续执行。" : "已拒绝并继续执行。"),
      ],
      {
        agent: result.agent,
        uiMessages: result.uiMessages,
      },
    );
  }
}
