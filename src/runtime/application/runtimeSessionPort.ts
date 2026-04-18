import type {
  SessionMutationResult,
} from "../../session/index.js";
import type {
  PendingApprovalCheckpoint,
  SessionEvent,
  SessionRefInfo,
  SessionSnapshot,
  SessionWorkingHead,
} from "../../types.js";

export interface RuntimeSessionPort {
  getHead(headId?: string): Promise<SessionWorkingHead>;
  getHeadStatus(
    headId?: string,
    snapshot?: SessionSnapshot,
  ): Promise<SessionRefInfo>;
  getPendingApprovalCheckpoint(
    headId?: string,
  ): Promise<PendingApprovalCheckpoint | undefined>;
  savePendingApprovalCheckpoint(
    checkpoint: PendingApprovalCheckpoint,
  ): Promise<void>;
  clearPendingApprovalCheckpoint(headId: string): Promise<void>;
  updateHeadRuntimeState(
    headId: string,
    patch: Partial<SessionWorkingHead["runtimeState"]>,
  ): Promise<SessionWorkingHead>;
  prepareHeadForUserInput(
    headId: string,
    snapshot?: SessionSnapshot,
  ): Promise<SessionMutationResult | undefined>;
  flushCompactSnapshot(snapshot: SessionSnapshot): Promise<boolean>;
  persistWorkingEvent(event: SessionEvent): Promise<void>;
  persistWorkingSnapshot(
    snapshot: SessionSnapshot,
    status?: SessionWorkingHead["status"],
  ): Promise<void>;
}
