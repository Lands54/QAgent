import type { ToolCall, ToolDefinition, ToolResult } from "../types.js";
import type { PersistentShellSession } from "./shellSession.js";
import { truncate } from "../utils/index.js";

function detectInteractiveCommand(command: string): string | undefined {
  const patterns = [
    /\bvim\b/i,
    /\bnvim\b/i,
    /\bnano\b/i,
    /\bless\b/i,
    /\bmore\b/i,
    /\btop\b/i,
    /\bhtop\b/i,
    /\bwatch\b/i,
    /^\s*ssh\b/i,
    /^\s*tmux\b/i,
    /^\s*screen\b/i,
  ];

  if (patterns.some((pattern) => pattern.test(command))) {
    return "检测到可能需要交互式终端的命令，当前版本只支持非交互式 shell 命令。";
  }

  return undefined;
}

export function formatToolResultForModel(result: ToolResult): string {
  return [
    `command: ${result.command}`,
    `status: ${result.status}`,
    `exit_code: ${result.exitCode ?? "null"}`,
    `cwd: ${result.cwd}`,
    `stdout:\n${result.stdout || "(empty)"}`,
    `stderr:\n${result.stderr || "(empty)"}`,
  ].join("\n");
}

export class ShellTool {
  public constructor(
    private readonly session: PersistentShellSession,
    private readonly maxOutputChars: number,
  ) {}

  public getDefinition(): ToolDefinition {
    return {
      name: "shell",
      description:
        "在持久 shell 会话中执行非交互式命令。支持上下文延续、cd 和环境变量继承。",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的非交互式 shell 命令。",
          },
          reasoning: {
            type: "string",
            description: "为什么需要执行该命令。",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    };
  }

  public getRuntimeStatus(): { cwd: string } {
    return {
      cwd: this.session.getCurrentCwd(),
    };
  }

  public async execute(
    toolCall: ToolCall,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      onStdoutChunk?: (chunk: string) => void;
      onStderrChunk?: (chunk: string) => void;
    },
  ): Promise<ToolResult> {
    const rejectionReason = detectInteractiveCommand(toolCall.input.command);
    if (rejectionReason) {
      const now = new Date().toISOString();
      return {
        callId: toolCall.id,
        name: "shell",
        command: toolCall.input.command,
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: rejectionReason,
        cwd: this.session.getCurrentCwd(),
        durationMs: 0,
        startedAt: now,
        finishedAt: now,
      };
    }

    const result = await this.session.execute(toolCall.input.command, options);
    const status =
      result.termination === "timeout"
        ? "timeout"
        : result.termination === "cancelled"
          ? "cancelled"
          : result.exitCode === 0
            ? "success"
            : "error";

    return {
      callId: toolCall.id,
      name: "shell",
      command: toolCall.input.command,
      status,
      exitCode: result.exitCode,
      stdout: truncate(result.stdout, this.maxOutputChars),
      stderr: truncate(result.stderr, this.maxOutputChars),
      cwd: result.cwd,
      durationMs: result.durationMs,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    };
  }

  public async dispose(): Promise<void> {
    await this.session.dispose();
  }
}
