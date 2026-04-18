import type {
  SessionCommitRecord,
  SessionRefInfo,
  SessionSnapshot,
  SessionWorkingHead,
} from "../../types.js";

export interface SessionMutationResult {
  ref: SessionRefInfo;
  head: SessionWorkingHead;
  message: string;
}

export interface SessionCheckoutResult extends SessionMutationResult {
  snapshot: SessionSnapshot;
}

export interface SessionHeadForkResult extends SessionMutationResult {
  snapshot: SessionSnapshot;
}

export interface SessionHeadSwitchResult extends SessionMutationResult {
  snapshot: SessionSnapshot;
}

export interface SessionCommitResult extends SessionMutationResult {
  commit: SessionCommitRecord;
}
