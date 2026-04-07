import { describe, expect, it } from "vitest";

import {
  parseCliInvocation,
  parseSlashCommand,
} from "../../src/command/index.js";

describe("CLI / Slash parser", () => {
  it("相同语义的 slash 与 structured CLI 会解析成等价命令", () => {
    const slash = parseSlashCommand("/session status");
    const cli = parseCliInvocation(["session", "status"]);

    expect(slash.handled).toBe(true);
    expect(slash.kind).toBe("command");
    expect(cli.mode).toBe("command");
    expect(cli.request).toEqual(slash.kind === "command" ? slash.request : undefined);
  });

  it("memory save 在 slash 与 structured CLI 下保持等价解析", () => {
    const slash = parseSlashCommand(
      "/memory save --global --name=reply-language --description=回复语言偏好 请默认使用中文回复",
    );
    const cli = parseCliInvocation([
      "memory",
      "save",
      "--global",
      "--name=reply-language",
      "--description=回复语言偏好",
      "请默认使用中文回复",
    ]);

    expect(slash.handled).toBe(true);
    expect(slash.kind).toBe("command");
    expect(cli.mode).toBe("command");
    expect(cli.request).toEqual(slash.kind === "command" ? slash.request : undefined);
  });

  it("未知首 token 仍兼容为 TUI 初始 prompt", () => {
    const cli = parseCliInvocation(["帮我看看当前项目结构"]);

    expect(cli.mode).toBe("tui");
    expect(cli.cliOptions.initialPrompt).toBe("帮我看看当前项目结构");
  });
});
