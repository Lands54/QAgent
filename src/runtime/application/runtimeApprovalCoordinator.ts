import { ApprovalRequiredInterruptError } from "../runtimeErrors.js";
import type {
  AgentLifecycleStatus,
  ApprovalDecision,
  ApprovalRequest,
  PendingApprovalCheckpoint,
  RuntimeEvent,
  ToolCall,
} from "../../types.js";
import { createId, firstLine } from "../../utils/index.js";
import type {
  ApprovalHandlingMode,
} from "./runtimeInputQueue.js";
import type { RuntimeSessionPort } from "./runtimeSessionPort.js";

export interface PendingApprovalState {
  request: ApprovalRequest;
  checkpoint: PendingApprovalCheckpoint;
  resolve?: (decision: ApprovalDecision) => void;
}

interface ToolExecutionResult {
  callId: string;
  name: "shell";
  command: string;
  status: "success" | "error" | "rejected" | "timeout" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

interface RuntimeApprovalCoordinatorDeps {
  agentId: string;
  headId: string;
  sessionId: string;
  getShellCwd(): string;
  getApprovalHandlingMode(): ApprovalHandlingMode;
  setApprovalHandlingMode(mode: ApprovalHandlingMode): void;
  sessionService: RuntimeSessionPort;
  setStatus(
    status: AgentLifecycleStatus,
    detail: string,
  ): Promise<void>;
  runLoop(input?: {
    startStep?: number;
    toolCalls?: ReadonlyArray<ToolCall>;
    nextToolCallIndex?: number;
    assistantMessageId?: string;
  }): Promise<void>;
  executeToolCall(toolCall: ToolCall): Promise<ToolExecutionResult>;
  commitToolResult(result: ToolExecutionResult): Promise<void>;
  onStateChanged(): void;
  emitRuntimeEvent<
    TType extends RuntimeEvent["type"],
  >(
    type: TType,
    payload: Extract<RuntimeEvent, { type: TType }>["payload"],
  ): void;
}

export class RuntimeApprovalCoordinator {
  private pendingApproval?: PendingApprovalState;

  public constructor(private readonly deps: RuntimeApprovalCoordinatorDeps) {}

  public getPendingApproval(): ApprovalRequest | undefined {
    return this.pendingApproval?.request;
  }

  public getPendingApprovalCheckpoint(): PendingApprovalCheckpoint | undefined {
    return this.pendingApproval?.checkpoint;
  }

  public hasPendingApproval(): boolean {
    return Boolean(this.pendingApproval);
  }

  public restoreFromCheckpoint(
    checkpoint: PendingApprovalCheckpoint,
  ): void {
    this.pendingApproval = {
      request: checkpoint.approvalRequest,
      checkpoint,
    };
  }

  public clearPendingApproval(): void {
    this.pendingApproval = undefined;
  }

  public async requestApproval(
    request: ApprovalRequest,
    context: {
      step: number;
      assistantMessageId: string;
      toolCalls: ReadonlyArray<ToolCall>;
      nextToolCallIndex: number;
    },
  ): Promise<ApprovalDecision> {
    const checkpoint: PendingApprovalCheckpoint = {
      checkpointId: createId("approval"),
      executorId: this.deps.agentId,
      worklineId: this.deps.headId,
      agentId: this.deps.agentId,
      headId: this.deps.headId,
      sessionId: this.deps.sessionId,
      toolCall: request.toolCall,
      approvalRequest: request,
      assistantMessageId: context.assistantMessageId,
      createdAt: new Date().toISOString(),
      resumeState: {
        step: context.step,
        toolCalls: [...context.toolCalls],
        nextToolCallIndex: context.nextToolCallIndex,
      },
    };
    this.pendingApproval = {
      request,
      checkpoint,
    };
    await this.deps.sessionService.savePendingApprovalCheckpoint(checkpoint);
    await this.deps.setStatus(
      "awaiting-approval",
      firstLine(request.summary, "等待审批"),
    );
    this.deps.emitRuntimeEvent("approval.required", {
      checkpoint,
    });
    if (this.deps.getApprovalHandlingMode() === "checkpoint") {
      throw new ApprovalRequiredInterruptError(checkpoint);
    }
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = {
        request,
        checkpoint,
        resolve,
      };
      this.deps.onStateChanged();
    });
  }

  public async resolveApproval(approved: boolean): Promise<void> {
    const pending = this.pendingApproval
      ?? await this.restorePendingApprovalFromCheckpoint();
    if (!pending) {
      return;
    }

    await this.deps.sessionService.clearPendingApprovalCheckpoint(this.deps.headId);
    this.deps.emitRuntimeEvent("approval.resolved", {
      checkpointId: pending.checkpoint.checkpointId,
      approved,
      requestId: pending.request.id,
      toolCall: pending.request.toolCall,
    });

    if (pending.resolve) {
      await this.deps.setStatus(
        "running",
        approved ? "审批已通过，继续执行" : "审批已拒绝，继续记录结果",
      );
      pending.resolve({
        requestId: pending.request.id,
        approved,
        decidedAt: new Date().toISOString(),
      });
      return;
    }

    await this.deps.setStatus(
      "running",
      approved ? "审批已通过，继续执行" : "审批已拒绝，继续记录结果",
    );
    await this.resumeFromPendingApproval(pending.checkpoint, approved);
  }

  public async restorePendingApprovalFromCheckpoint(): Promise<PendingApprovalState | undefined> {
    const checkpoint =
      await this.deps.sessionService.getPendingApprovalCheckpoint(this.deps.headId);
    if (!checkpoint) {
      return undefined;
    }
    const restored = {
      request: checkpoint.approvalRequest,
      checkpoint,
    };
    this.pendingApproval = restored;
    return restored;
  }

  private async resumeFromPendingApproval(
    checkpoint: PendingApprovalCheckpoint,
    approved: boolean,
  ): Promise<void> {
    const currentToolCall = checkpoint.resumeState.toolCalls[
      checkpoint.resumeState.nextToolCallIndex
    ];
    if (!currentToolCall) {
      await this.deps.runLoop({
        startStep: checkpoint.resumeState.step + 1,
      });
      return;
    }

    const toolResult = approved
      ? await this.deps.executeToolCall(currentToolCall)
      : {
          callId: currentToolCall.id,
          name: "shell" as const,
          command: currentToolCall.input.command,
          status: "rejected" as const,
          exitCode: null,
          stdout: "",
          stderr: "命令执行被用户拒绝。",
          cwd: this.deps.getShellCwd(),
          durationMs: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
    await this.deps.commitToolResult(toolResult);

    const nextToolCallIndex = checkpoint.resumeState.nextToolCallIndex + 1;
    if (nextToolCallIndex < checkpoint.resumeState.toolCalls.length) {
      this.deps.setApprovalHandlingMode("checkpoint");
      await this.deps.runLoop({
        startStep: checkpoint.resumeState.step,
        toolCalls: checkpoint.resumeState.toolCalls,
        nextToolCallIndex,
        assistantMessageId: checkpoint.assistantMessageId,
      });
      return;
    }

    this.deps.setApprovalHandlingMode("checkpoint");
    await this.deps.runLoop({
      startStep: checkpoint.resumeState.step + 1,
    });
  }
}
