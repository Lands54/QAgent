import type { ApprovalMode, ApprovalRequest, ToolCall } from "../types.js";
import { createId } from "../utils/index.js";

const HIGH_RISK_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bsudo\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bnpm\s+publish\b/i,
  /\bkill(?:all)?\b/i,
  />\s*[^ ]+/i,
  /\bcurl\b.+\|\s*(?:bash|sh)\b/i,
];

export interface ApprovalAssessment {
  requiresApproval: boolean;
  request?: ApprovalRequest;
}

function detectRiskLevel(command: string): ApprovalRequest["riskLevel"] {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command))
    ? "high"
    : "medium";
}

export class ApprovalPolicy {
  private mode: ApprovalMode;

  public constructor(mode: ApprovalMode) {
    this.mode = mode;
  }

  public getMode(): ApprovalMode {
    return this.mode;
  }

  public setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  public evaluate(toolCall: ToolCall): ApprovalAssessment {
    if (this.mode === "never") {
      return { requiresApproval: false };
    }

    const riskLevel = detectRiskLevel(toolCall.input.command);
    if (this.mode === "risky" && riskLevel === "medium") {
      return { requiresApproval: false };
    }

    return {
      requiresApproval: true,
      request: {
        id: createId("approval"),
        toolCall,
        summary: `执行 shell 命令：${toolCall.input.command}`,
        riskLevel,
        createdAt: new Date().toISOString(),
      },
    };
  }
}
