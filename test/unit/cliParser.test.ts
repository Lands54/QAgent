import { describe, expect, it } from "vitest";

import {
  parseCliInvocation,
  parseSlashCommand,
} from "../../src/command/index.js";

describe("CLI / Slash parser", () => {
  it("无参数默认显示 help，而不是启动 TUI", () => {
    const cli = parseCliInvocation([]);

    expect(cli.mode).toBe("help");
  });

  it("显式 tui 子命令会进入 TUI", () => {
    const cli = parseCliInvocation(["tui"]);

    expect(cli.mode).toBe("tui");
    expect(cli.cliOptions.initialPrompt).toBeUndefined();
  });

  it("显式 tui 子命令支持初始 prompt", () => {
    const cli = parseCliInvocation(["tui", "帮我看看当前项目结构"]);

    expect(cli.mode).toBe("tui");
    expect(cli.cliOptions.initialPrompt).toBe("帮我看看当前项目结构");
  });

  it("resume 仍保持显式 TUI 入口语义", () => {
    const latest = parseCliInvocation(["resume"]);
    const specific = parseCliInvocation(["resume", "session_123"]);

    expect(latest.mode).toBe("tui");
    expect(latest.cliOptions.resumeSessionId).toBe("latest");
    expect(specific.mode).toBe("tui");
    expect(specific.cliOptions.resumeSessionId).toBe("session_123");
  });

  it("相同语义的 slash 与 structured CLI 会解析成等价命令", () => {
    const slash = parseSlashCommand("/work status");
    const cli = parseCliInvocation(["work", "status"]);

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

  it("未知首 token 会作为 CLI run prompt 处理", () => {
    const cli = parseCliInvocation(["帮我看看当前项目结构"]);

    expect(cli.mode).toBe("command");
    expect(cli.request).toEqual({
      domain: "run",
      prompt: "帮我看看当前项目结构",
    });
  });

  it("支持 edge 子命令与远程 transport 参数", () => {
    const cli = parseCliInvocation([
      "--transport",
      "remote",
      "--workspace",
      "workspace-alpha",
      "--edge-url",
      "https://edge.example.com",
      "--api-token",
      "secret-token",
      "edge",
      "status",
    ]);

    expect(cli.mode).toBe("edge");
    expect(cli.edgeAction).toBe("status");
    expect(cli.cliOptions.transportMode).toBe("remote");
    expect(cli.cliOptions.workspaceId).toBe("workspace-alpha");
    expect(cli.cliOptions.edgeBaseUrl).toBe("https://edge.example.com");
    expect(cli.cliOptions.apiToken).toBe("secret-token");
  });

  it("顶层选项缺值时不会吞掉后续 flag", () => {
    const cli = parseCliInvocation(["--cwd", "--json", "run", "hi"]);

    expect(cli.mode).toBe("help");
    expect(cli.error).toContain("--cwd");
    expect(cli.cliOptions.cwd).toBeUndefined();
    expect(cli.output).toBe("text");
  });

  it("会拒绝非法的顶层枚举参数", () => {
    const provider = parseCliInvocation(["--provider", "anthropic", "run", "hi"]);
    const transport = parseCliInvocation(["--transport", "tunnel", "edge", "status"]);

    expect(provider.mode).toBe("help");
    expect(provider.error).toContain("--provider");
    expect(provider.cliOptions.provider).toBeUndefined();
    expect(transport.mode).toBe("help");
    expect(transport.error).toContain("--transport");
    expect(transport.cliOptions.transportMode).toBeUndefined();
  });

  it("会拒绝非法的 edge 端口参数", () => {
    const cli = parseCliInvocation(["--edge-port", "abc", "edge", "serve"]);

    expect(cli.mode).toBe("help");
    expect(cli.error).toContain("--edge-port");
    expect(cli.cliOptions.edgePort).toBeUndefined();
  });

  it("支持 gateway 子命令", () => {
    const cli = parseCliInvocation(["gateway", "status"]);

    expect(cli.mode).toBe("gateway");
    expect(cli.gatewayAction).toBe("status");
  });
});
