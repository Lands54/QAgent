import type { ToolCall, ToolDefinition, ToolResult } from "../types.js";
import type { ShellTool } from "./shellTool.js";

export class ToolRegistry {
  public constructor(private readonly shellTool: ShellTool) {}

  public getDefinitions(): ToolDefinition[] {
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
    },
  ): Promise<ToolResult> {
    if (toolCall.name !== "shell") {
      throw new Error(`未知工具：${toolCall.name}`);
    }

    return this.shellTool.execute(toolCall, options);
  }
}
