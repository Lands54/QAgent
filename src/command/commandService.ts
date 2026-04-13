import type {
  ApprovalMode,
  BookmarkListView,
  CommandMessage,
  CommandRequest,
  CommandResult,
  ExecutorListView,
  ExecutorView,
  MemoryRecord,
  ModelProvider,
  PendingApprovalCheckpoint,
  SessionCommitListView,
  SessionLogEntry,
  SessionRefInfo,
  SkillManifest,
  UIMessage,
  WorklineListView,
  WorklineView,
} from "../types.js";
import {
  formatBookmark,
  formatExecutor,
  formatWorkline,
} from "./common.js";

interface SessionCheckoutResultLike {
  ref: SessionRefInfo;
  message: string;
}

interface SettledCommandRunResult {
  settled: "completed" | "approval_required" | "interrupted" | "error";
  executor: ExecutorView;
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
  getWorklineStatus: (worklineId?: string) => Promise<WorklineView>;
  listWorklines: () => Promise<WorklineListView>;
  createWorkline: (name: string) => Promise<WorklineView>;
  switchWorkline: (worklineId: string) => Promise<WorklineView>;
  switchWorklineRelative: (offset: number) => Promise<WorklineView>;
  closeWorkline: (worklineId: string) => Promise<WorklineView>;
  detachWorkline: (worklineId?: string) => Promise<WorklineView>;
  mergeWorkline: (source: string) => Promise<WorklineView>;
  getBookmarkStatus: () => Promise<{
    current?: string;
    bookmarks: BookmarkListView["bookmarks"];
  }>;
  listBookmarks: () => Promise<BookmarkListView>;
  createBookmark: (name: string) => Promise<SessionRefInfo>;
  createTagBookmark: (name: string) => Promise<SessionRefInfo>;
  switchBookmark: (bookmark: string) => Promise<SessionCheckoutResultLike>;
  mergeBookmark: (source: string) => Promise<SessionRefInfo>;
  getExecutorStatus: (executorId?: string) => Promise<ExecutorView>;
  listExecutors: () => Promise<ExecutorListView>;
  interruptExecutor: (executorId?: string) => Promise<void>;
  resumeExecutor: (executorId?: string) => Promise<void>;
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
  resetModelContext: () => Promise<{
    resetEntryCount: number;
  }>;
  commitSession: (message: string) => Promise<{
    id: string;
    message: string;
    nodeId: string;
    headId: string;
    sessionId: string;
    createdAt: string;
  }>;
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
          return await this.handleRun(request);
        case "model":
          return await this.handleModel(request);
        case "tool":
          return await this.handleTool(request);
        case "hook":
          return await this.handleHook(request);
        case "debug":
          return await this.handleDebug(request);
        case "memory":
          return await this.handleMemory(request);
        case "skills":
          return await this.handleSkills(request);
        case "work":
          return await this.handleWork(request);
        case "bookmark":
          return await this.handleBookmark(request);
        case "executor":
          return await this.handleExecutor(request);
        case "session":
          return await this.handleSession(request);
        case "approval":
          return await this.handleApproval(request);
        case "clear":
          await this.deps.clearUi();
          return success("clear.success", [info("已清空当前工作线的 UI 消息。")]);
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
    const approvalHandlingMode = this.deps.getApprovalMode() === "never"
      ? undefined
      : "checkpoint";
    const result = await this.deps.runPrompt(request.prompt, {
      agentId: request.agentId,
      approvalMode: approvalHandlingMode,
      modelInputAppendix: request.modelInputAppendix,
    });
    if (result.settled === "approval_required" && result.checkpoint) {
      return approvalRequired(result.checkpoint, result.uiMessages);
    }
    if (result.settled === "error") {
      return runtimeErrorResult("run.executor_error", result.executor.detail, {
        executor: result.executor,
        uiMessages: result.uiMessages,
      });
    }
    if (result.settled === "interrupted") {
      return runtimeErrorResult("run.interrupted", result.executor.detail, {
        executor: result.executor,
        uiMessages: result.uiMessages,
      });
    }
    return success("run.completed", [], {
      executor: result.executor,
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
      if (!record) {
        return runtimeErrorResult(
          "memory.not_found",
          `未找到 memory：${request.name}`,
          { record },
        );
      }
      return success(
        "memory.show",
        [
          info(
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
          ),
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

    if (!request.key) {
      return validationError("skills.show_usage", "用法：skills show <name|id>");
    }
    const skill = skills.find((item) => item.id === request.key || item.name === request.key);
    if (!skill) {
      return runtimeErrorResult(
        "skills.not_found",
        `未找到 skill：${request.key}`,
        { skill },
      );
    }
    return success(
      "skills.show",
      [
        info(
          [
            `id: ${skill.id}`,
            `name: ${skill.name}`,
            `description: ${skill.description}`,
            `path: ${skill.filePath}`,
            "说明：不需要手动激活，模型会在合适时自动使用。",
          ].join("\n"),
        ),
      ],
      {
        skill,
      },
    );
  }

  private async handleWork(
    request: Extract<CommandRequest, { domain: "work" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const workline = await this.deps.getWorklineStatus(request.worklineId);
      return success("work.status", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "list") {
      const worklines = await this.deps.listWorklines();
      return success(
        "work.list",
        [
          info(
            worklines.worklines.length === 0
              ? "当前没有工作线。"
              : worklines.worklines.map((workline) => formatWorkline(workline)).join("\n\n"),
          ),
        ],
        worklines,
      );
    }
    if (request.action === "new") {
      if (!request.name) {
        return validationError("work.new_usage", "用法：work new <name>");
      }
      const workline = await this.deps.createWorkline(request.name);
      return success("work.created", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "switch") {
      if (!request.worklineId) {
        return validationError("work.switch_usage", "用法：work switch <worklineId|name>");
      }
      const workline = await this.deps.switchWorkline(request.worklineId);
      return success("work.switched", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "next" || request.action === "prev") {
      const workline = await this.deps.switchWorklineRelative(request.action === "next" ? 1 : -1);
      return success("work.switched", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "close") {
      if (!request.worklineId) {
        return validationError("work.close_usage", "用法：work close <worklineId|name>");
      }
      const workline = await this.deps.closeWorkline(request.worklineId);
      return success("work.closed", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "detach") {
      const workline = await this.deps.detachWorkline(request.worklineId);
      return success("work.detached", [info(formatWorkline(workline))], { workline });
    }
    if (request.action === "merge") {
      if (!request.source) {
        return validationError("work.merge_usage", "用法：work merge <sourceWorkline>");
      }
      const workline = await this.deps.mergeWorkline(request.source);
      return success("work.merged", [info(formatWorkline(workline))], { workline });
    }
    return runtimeErrorResult("work.unknown_action", "未知的 work 子命令。");
  }

  private async handleBookmark(
    request: Extract<CommandRequest, { domain: "bookmark" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const status = await this.deps.getBookmarkStatus();
      return success(
        "bookmark.status",
        [
          info(
            status.bookmarks.length === 0
              ? "当前没有书签。"
              : [
                  status.current ? `current: ${status.current}` : "current: detached",
                  ...status.bookmarks.map((bookmark) => formatBookmark(bookmark)),
                ].join("\n"),
          ),
        ],
        status,
      );
    }
    if (request.action === "list") {
      const bookmarks = await this.deps.listBookmarks();
      return success(
        "bookmark.list",
        [
          info(
            bookmarks.bookmarks.length === 0
              ? "当前没有书签。"
              : bookmarks.bookmarks.map((bookmark) => formatBookmark(bookmark)).join("\n"),
          ),
        ],
        bookmarks,
      );
    }
    if (request.action === "save") {
      if (!request.name) {
        return validationError("bookmark.save_usage", "用法：bookmark save <name>");
      }
      const ref = await this.deps.createBookmark(request.name);
      return success("bookmark.saved", [info(`已保存书签 ${request.name}，当前书签=${ref.label}`)], { ref });
    }
    if (request.action === "tag") {
      if (!request.name) {
        return validationError("bookmark.tag_usage", "用法：bookmark tag <name>");
      }
      const ref = await this.deps.createTagBookmark(request.name);
      return success("bookmark.tagged", [info(`已创建只读书签 ${request.name}，当前书签=${ref.label}`)], { ref });
    }
    if (request.action === "switch") {
      if (!request.bookmark) {
        return validationError("bookmark.switch_usage", "用法：bookmark switch <name>");
      }
      const result = await this.deps.switchBookmark(request.bookmark);
      return success("bookmark.switched", [info(result.message)], result);
    }
    if (request.action === "merge") {
      if (!request.source) {
        return validationError("bookmark.merge_usage", "用法：bookmark merge <sourceBookmark>");
      }
      const ref = await this.deps.mergeBookmark(request.source);
      return success("bookmark.merged", [info(`已 merge 书签 ${request.source}，当前书签=${ref.label}`)], { ref });
    }
    return runtimeErrorResult("bookmark.unknown_action", "未知的 bookmark 子命令。");
  }

  private async handleExecutor(
    request: Extract<CommandRequest, { domain: "executor" }>,
  ): Promise<CommandResult> {
    if (request.action === "status") {
      const executor = await this.deps.getExecutorStatus(request.executorId);
      return success("executor.status", [info(formatExecutor(executor))], { executor });
    }
    if (request.action === "list") {
      const executors = await this.deps.listExecutors();
      return success(
        "executor.list",
        [
          info(
            executors.executors.length === 0
              ? "当前没有执行器。"
              : executors.executors.map((executor) => formatExecutor(executor)).join("\n\n"),
          ),
        ],
        executors,
      );
    }
    if (request.action === "interrupt") {
      await this.deps.interruptExecutor(request.executorId);
      return success("executor.interrupted", [info("已发送中断给目标执行器。")]);
    }
    if (request.action === "resume") {
      await this.deps.resumeExecutor(request.executorId);
      return success("executor.resumed", [info("已尝试继续目标执行器。")]);
    }
    return runtimeErrorResult("executor.unknown_action", "未知的 executor 子命令。");
  }

  private async handleSession(
    request: Extract<CommandRequest, { domain: "session" }>,
  ): Promise<CommandResult> {
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
                  `summaryExecutor=${result.agentId ?? "N/A"}`,
                ].join("\n")
              : "当前上下文不足以 compact，已跳过。",
          ),
        ],
        result,
      );
    }
    if (request.action === "reset-context") {
      const result = await this.deps.resetModelContext();
      return success(
        "session.model_context_reset",
        [
          info(
            result.resetEntryCount > 0
              ? `已重置当前 working snapshot 的模型上下文，清理 ${result.resetEntryCount} 条投影来源；UI 历史与既有节点保持不变。`
              : "当前 working snapshot 没有可清理的模型上下文；UI 历史与既有节点保持不变。",
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
                  `executor: ${checkpoint.executorId}`,
                  `workline: ${checkpoint.worklineId}`,
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
      return runtimeErrorResult("approval.resume_error", result.executor.detail, {
        executor: result.executor,
        uiMessages: result.uiMessages,
      });
    }
    if (result.settled === "interrupted") {
      return runtimeErrorResult("approval.resume_interrupted", result.executor.detail, {
        executor: result.executor,
        uiMessages: result.uiMessages,
      });
    }
    return success(
      request.action === "approve" ? "approval.approved" : "approval.rejected",
      [
        info(request.action === "approve" ? "已批准并继续执行。" : "已拒绝并继续执行。"),
      ],
      {
        executor: result.executor,
        uiMessages: result.uiMessages,
      },
    );
  }
}
