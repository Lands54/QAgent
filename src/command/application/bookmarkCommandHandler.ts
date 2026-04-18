import { formatBookmark } from "../common.js";
import type { CommandRequest, CommandResult } from "../../types.js";
import type { CommandHandler } from "./commandHandler.js";
import type { BookmarkCommandDeps } from "./commandDeps.js";
import {
  info,
  runtimeErrorResult,
  success,
  validationError,
} from "./commandResultFactory.js";

export class BookmarkCommandHandler implements CommandHandler<Extract<CommandRequest, { domain: "bookmark" }>> {
  public constructor(private readonly deps: BookmarkCommandDeps) {}

  public async handle(
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
}
