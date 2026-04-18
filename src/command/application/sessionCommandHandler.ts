import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { SessionCommandDeps } from "./commandDeps.js";
import {
  info,
  runtimeErrorResult,
  success,
  validationError,
} from "./commandResultFactory.js";

export class SessionCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "session" }>> {
  public constructor(private readonly deps: SessionCommandDeps) {}

  public async handle(
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
              : "暂无会话图节点。",
          ),
        ],
        {
          log,
        },
      );
    }
    return runtimeErrorResult("session.unknown_action", "未知的 session 子命令。");
  }
}
