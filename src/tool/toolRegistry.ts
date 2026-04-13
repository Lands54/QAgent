import type { ToolCall, ToolDefinition, ToolResult } from "../types.js";
import type { ShellTool } from "./shellTool.js";

export class ToolRegistry {
  public constructor(
    private readonly shellTool: ShellTool,
    private readonly options: {
      allowShell?: boolean;
    } = {},
  ) {}

  public getDefinitions(): ToolDefinition[] {
    if (this.options.allowShell === false) {
      return [];
    }
    return [this.shellTool.getDefinition()];
  }

  public getShellTool(): ShellTool {
    return this.shellTool;
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
    if (this.options.allowShell === false) {
      throw new Error("当前 agent 不允许调用工具。");
    }
    if (toolCall.name !== "shell") {
      throw new Error(`未知工具：${toolCall.name}`);
    }

    return this.shellTool.execute(toolCall, options);
  }
}
