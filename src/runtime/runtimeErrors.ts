import type { PendingApprovalCheckpoint } from "../types.js";

export class ApprovalRequiredInterruptError extends Error {
  public constructor(public readonly checkpoint: PendingApprovalCheckpoint) {
    super("需要审批后才能继续执行。");
    this.name = "ApprovalRequiredInterruptError";
  }
}
