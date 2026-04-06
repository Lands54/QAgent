import type {
  ApprovalMode,
  ApprovalRequest,
  LlmMessage,
  SessionRefInfo,
  SessionSnapshot,
  SkillManifest,
  UIMessage,
} from "../types.js";

export interface AgentStatus {
  mode: "booting" | "idle" | "running" | "awaiting-approval" | "interrupted" | "error";
  detail: string;
  updatedAt: string;
}

export interface AppState {
  sessionId: string;
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
  status: AgentStatus;
  uiMessages: UIMessage[];
  draftAssistantText: string;
  modelMessages: LlmMessage[];
  availableSkills: SkillManifest[];
  sessionRef?: SessionRefInfo;
  pendingApproval?: ApprovalRequest;
  shouldExit: boolean;
  lastUserPrompt?: string;
}

export type AppEvent =
  | { type: "session.loaded"; snapshot: SessionSnapshot }
  | { type: "session.ref.updated"; ref: SessionRefInfo }
  | { type: "skills.available"; skills: SkillManifest[] }
  | {
      type: "status.set";
      mode: AgentStatus["mode"];
      detail: string;
    }
  | { type: "ui.message.add"; message: UIMessage }
  | { type: "model.message.add"; message: LlmMessage }
  | { type: "assistant.stream.start" }
  | { type: "assistant.stream.delta"; delta: string }
  | { type: "assistant.stream.finish" }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.resolved" }
  | { type: "tool.cwd.updated"; cwd: string }
  | { type: "tool.approval_mode.updated"; mode: ApprovalMode }
  | { type: "last_user_prompt.set"; prompt: string }
  | { type: "ui.cleared" }
  | { type: "exit.requested" };

export function createEmptyState(cwd: string): AppState {
  const now = new Date().toISOString();
  return {
    sessionId: "",
    cwd,
    shellCwd: cwd,
    approvalMode: "always",
    status: {
      mode: "booting",
      detail: "初始化中",
      updatedAt: now,
    },
    uiMessages: [],
    draftAssistantText: "",
    modelMessages: [],
    availableSkills: [],
    shouldExit: false,
  };
}

export function reduceAppEvent(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "session.loaded":
      return {
        ...state,
        sessionId: event.snapshot.sessionId,
        cwd: event.snapshot.cwd,
        shellCwd: event.snapshot.shellCwd,
        approvalMode: event.snapshot.approvalMode,
        uiMessages: event.snapshot.uiMessages,
        modelMessages: event.snapshot.modelMessages,
        lastUserPrompt: event.snapshot.lastUserPrompt,
      };
    case "skills.available":
      return {
        ...state,
        availableSkills: event.skills,
      };
    case "session.ref.updated":
      return {
        ...state,
        sessionRef: event.ref,
      };
    case "status.set":
      return {
        ...state,
        status: {
          mode: event.mode,
          detail: event.detail,
          updatedAt: new Date().toISOString(),
        },
      };
    case "ui.message.add":
      return {
        ...state,
        uiMessages: [...state.uiMessages, event.message],
      };
    case "model.message.add":
      return {
        ...state,
        modelMessages: [...state.modelMessages, event.message],
      };
    case "assistant.stream.start":
      return {
        ...state,
        draftAssistantText: "",
      };
    case "assistant.stream.delta":
      return {
        ...state,
        draftAssistantText: `${state.draftAssistantText}${event.delta}`,
      };
    case "assistant.stream.finish":
      return {
        ...state,
        draftAssistantText: "",
      };
    case "approval.requested":
      return {
        ...state,
        pendingApproval: event.request,
      };
    case "approval.resolved":
      return {
        ...state,
        pendingApproval: undefined,
      };
    case "tool.cwd.updated":
      return {
        ...state,
        shellCwd: event.cwd,
      };
    case "tool.approval_mode.updated":
      return {
        ...state,
        approvalMode: event.mode,
      };
    case "last_user_prompt.set":
      return {
        ...state,
        lastUserPrompt: event.prompt,
      };
    case "ui.cleared":
      return {
        ...state,
        uiMessages: [],
      };
    case "exit.requested":
      return {
        ...state,
        shouldExit: true,
      };
    default:
      return state;
  }
}

export function toSessionSnapshot(state: AppState): SessionSnapshot {
  const now = new Date().toISOString();
  return {
    sessionId: state.sessionId,
    createdAt: now,
    updatedAt: now,
    cwd: state.cwd,
    shellCwd: state.shellCwd,
    approvalMode: state.approvalMode,
    uiMessages: state.uiMessages,
    modelMessages: state.modelMessages,
    lastUserPrompt: state.lastUserPrompt,
  };
}
