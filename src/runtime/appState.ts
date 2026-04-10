import type {
  AgentKind,
  AgentLifecycleStatus,
  AgentViewState,
  ApprovalMode,
  ApprovalRequest,
  BookmarkView,
  ExecutorView,
  LlmMessage,
  SessionRefInfo,
  SessionSnapshot,
  SessionWorkingHead,
  SkillManifest,
  UIMessage,
  WorklineView,
} from "../types.js";

export interface AgentStatus {
  mode: AgentLifecycleStatus;
  detail: string;
  updatedAt: string;
}

export interface AppState {
  activeWorklineId: string;
  activeWorklineName?: string;
  activeExecutorId: string;
  activeExecutorKind?: AgentKind;
  activeQueuedInputCount: number;
  activeBookmarkLabel?: string;
  worklines: WorklineView[];
  executors: ExecutorView[];
  bookmarks: BookmarkView[];
  activeAgentId: string;
  activeAgentKind?: AgentKind;
  activeWorkingHeadId: string;
  activeWorkingHeadName?: string;
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
  sessionHead?: SessionWorkingHead;
  pendingApproval?: ApprovalRequest;
  pendingApprovals: Record<string, ApprovalRequest>;
  agents: AgentViewState[];
  shouldExit: boolean;
  lastUserPrompt?: string;
  currentTokenEstimate: number;
  autoCompactThresholdTokens: number;
  helperActivities: string[];
}

export type AppEvent = never;

export function createEmptyState(cwd: string): AppState {
  const now = new Date().toISOString();
  return {
    activeWorklineId: "",
    activeExecutorId: "",
    activeQueuedInputCount: 0,
    worklines: [],
    executors: [],
    bookmarks: [],
    activeAgentId: "",
    activeWorkingHeadId: "",
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
    pendingApprovals: {},
    agents: [],
    shouldExit: false,
    currentTokenEstimate: 0,
    autoCompactThresholdTokens: 0,
    helperActivities: [],
  };
}

export function reduceAppEvent(state: AppState): AppState {
  return state;
}

export function toSessionSnapshot(state: AppState): SessionSnapshot {
  const now = new Date().toISOString();
  return {
    workingHeadId: state.activeWorkingHeadId,
    sessionId: state.sessionId,
    createdAt: now,
    updatedAt: now,
    cwd: state.cwd,
    shellCwd: state.shellCwd,
    approvalMode: state.approvalMode,
    conversationEntries: [],
    uiMessages: state.uiMessages,
    modelMessages: state.modelMessages,
    lastUserPrompt: state.lastUserPrompt,
  };
}
