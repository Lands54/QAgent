import type {
  ApprovalMode,
  BookmarkListView,
  CommandRequest,
  ExecutorListView,
  ExecutorView,
  MemoryRecord,
  ModelProvider,
  PendingApprovalCheckpoint,
  SessionCommitListView,
  SessionLogEntry,
  SessionRefInfo,
  SkillManifest,
  UIMessage,
  WorklineListView,
  WorklineView,
} from "../../types.js";

export interface SessionCheckoutResultLike {
  ref: SessionRefInfo;
  message: string;
}

export interface SettledCommandRunResult {
  settled: "completed" | "approval_required" | "interrupted" | "error";
  executor: ExecutorView;
  checkpoint?: PendingApprovalCheckpoint;
  uiMessages: ReadonlyArray<UIMessage>;
}

export interface CommandServiceDependencies {
  getSessionId: () => string;
  getActiveHeadId: () => string;
  getActiveAgentId?: () => string;
  getShellCwd: () => string;
  getHookStatus: () => {
    fetchMemory: boolean;
    saveMemory: boolean;
    autoCompact: boolean;
  };
  getDebugStatus: () => Promise<{
    helperAgentAutoCleanup: boolean;
    helperAgentCount: number;
    legacyAgentCount: number;
    uiContextEnabled: boolean;
  }>;
  getApprovalMode: () => ApprovalMode;
  getModelStatus: () => {
    provider: ModelProvider;
    model: string;
    baseUrl: string;
    apiKeyMasked?: string;
  };
  getStatusLine: () => string;
  getAvailableSkills: () => SkillManifest[];
  setApprovalMode: (mode: ApprovalMode) => Promise<void>;
  setFetchMemoryHookEnabled: (enabled: boolean) => Promise<void>;
  setSaveMemoryHookEnabled: (enabled: boolean) => Promise<void>;
  setAutoCompactHookEnabled: (enabled: boolean) => Promise<void>;
  setUiContextEnabled: (enabled: boolean) => Promise<void>;
  setHelperAgentAutoCleanupEnabled: (enabled: boolean) => Promise<void>;
  setModelProvider: (provider: ModelProvider) => Promise<void>;
  setModelName: (model: string) => Promise<void>;
  setModelApiKey: (apiKey: string) => Promise<void>;
  listMemory: (limit?: number) => Promise<MemoryRecord[]>;
  saveMemory: (input: {
    name: string;
    description: string;
    content: string;
    scope?: "project" | "global";
  }) => Promise<MemoryRecord>;
  showMemory: (name: string) => Promise<MemoryRecord | undefined>;
  getWorklineStatus: (worklineId?: string) => Promise<WorklineView>;
  listWorklines: () => Promise<WorklineListView>;
  createWorkline: (name: string) => Promise<WorklineView>;
  switchWorkline: (worklineId: string) => Promise<WorklineView>;
  switchWorklineRelative: (offset: number) => Promise<WorklineView>;
  closeWorkline: (worklineId: string) => Promise<WorklineView>;
  detachWorkline: (worklineId?: string) => Promise<WorklineView>;
  mergeWorkline: (source: string) => Promise<WorklineView>;
  getBookmarkStatus: () => Promise<{
    current?: string;
    bookmarks: BookmarkListView["bookmarks"];
  }>;
  listBookmarks: () => Promise<BookmarkListView>;
  createBookmark: (name: string) => Promise<SessionRefInfo>;
  createTagBookmark: (name: string) => Promise<SessionRefInfo>;
  switchBookmark: (bookmark: string) => Promise<SessionCheckoutResultLike>;
  mergeBookmark: (source: string) => Promise<SessionRefInfo>;
  getExecutorStatus: (executorId?: string) => Promise<ExecutorView>;
  listExecutors: () => Promise<ExecutorListView>;
  interruptExecutor: (executorId?: string) => Promise<void>;
  resumeExecutor: (executorId?: string) => Promise<void>;
  listSessionCommits: (limit?: number) => Promise<SessionCommitListView>;
  listSessionGraphLog: (limit?: number) => Promise<SessionLogEntry[]>;
  listSessionLog: (limit?: number) => Promise<SessionLogEntry[]>;
  compactSession: () => Promise<{
    compacted: boolean;
    agentId?: string;
    beforeTokens: number;
    afterTokens: number;
    keptGroups: number;
    removedGroups: number;
  }>;
  resetModelContext: () => Promise<{
    resetEntryCount: number;
  }>;
  commitSession: (message: string) => Promise<{
    id: string;
    message: string;
    nodeId: string;
    headId: string;
    sessionId: string;
    createdAt: string;
  }>;
  clearHelperAgents: () => Promise<{
    cleared: number;
    skippedRunning: number;
  }>;
  clearLegacyAgents: () => Promise<{
    cleared: number;
    skippedRunning: number;
    skippedActive: number;
  }>;
  clearUi: () => Promise<void>;
  runPrompt: (
    prompt: string,
    input?: {
      agentId?: string;
      approvalMode?: "interactive" | "checkpoint";
      modelInputAppendix?: string;
    },
  ) => Promise<SettledCommandRunResult>;
  getPendingApproval: (input?: {
    checkpointId?: string;
    agentId?: string;
    headId?: string;
  }) => Promise<PendingApprovalCheckpoint | undefined>;
  resolvePendingApproval: (
    approved: boolean,
    input?: {
      checkpointId?: string;
      agentId?: string;
      headId?: string;
    },
  ) => Promise<SettledCommandRunResult>;
}

export type RunCommandDeps = Pick<
  CommandServiceDependencies,
  "getApprovalMode" | "runPrompt"
>;

export type ModelCommandDeps = Pick<
  CommandServiceDependencies,
  | "getModelStatus"
  | "setModelProvider"
  | "setModelName"
  | "setModelApiKey"
>;

export type ToolCommandDeps = Pick<
  CommandServiceDependencies,
  "getApprovalMode" | "getShellCwd" | "setApprovalMode"
>;

export type HookCommandDeps = Pick<
  CommandServiceDependencies,
  | "getHookStatus"
  | "setFetchMemoryHookEnabled"
  | "setSaveMemoryHookEnabled"
  | "setAutoCompactHookEnabled"
>;

export type DebugCommandDeps = Pick<
  CommandServiceDependencies,
  | "getDebugStatus"
  | "setHelperAgentAutoCleanupEnabled"
  | "clearHelperAgents"
  | "clearLegacyAgents"
  | "setUiContextEnabled"
>;

export type MemoryCommandDeps = Pick<
  CommandServiceDependencies,
  "listMemory" | "showMemory" | "saveMemory"
>;

export type SkillsCommandDeps = Pick<
  CommandServiceDependencies,
  "getAvailableSkills"
>;

export type WorklineCommandDeps = Pick<
  CommandServiceDependencies,
  | "getWorklineStatus"
  | "listWorklines"
  | "createWorkline"
  | "switchWorkline"
  | "switchWorklineRelative"
  | "closeWorkline"
  | "detachWorkline"
  | "mergeWorkline"
>;

export type BookmarkCommandDeps = Pick<
  CommandServiceDependencies,
  | "getBookmarkStatus"
  | "listBookmarks"
  | "createBookmark"
  | "createTagBookmark"
  | "switchBookmark"
  | "mergeBookmark"
>;

export type ExecutorCommandDeps = Pick<
  CommandServiceDependencies,
  | "getExecutorStatus"
  | "listExecutors"
  | "interruptExecutor"
  | "resumeExecutor"
>;

export type SessionCommandDeps = Pick<
  CommandServiceDependencies,
  | "compactSession"
  | "resetModelContext"
  | "commitSession"
  | "listSessionCommits"
  | "listSessionGraphLog"
>;

export type ApprovalCommandDeps = Pick<
  CommandServiceDependencies,
  "getPendingApproval" | "resolvePendingApproval"
>;

export type ClearCommandDeps = Pick<
  CommandServiceDependencies,
  "clearUi"
>;

export type CommandHandlerDeps = {
  run: RunCommandDeps;
  model: ModelCommandDeps;
  tool: ToolCommandDeps;
  hook: HookCommandDeps;
  debug: DebugCommandDeps;
  memory: MemoryCommandDeps;
  skills: SkillsCommandDeps;
  workline: WorklineCommandDeps;
  bookmark: BookmarkCommandDeps;
  executor: ExecutorCommandDeps;
  session: SessionCommandDeps;
  approval: ApprovalCommandDeps;
  clear: ClearCommandDeps;
};

export type CommandDomainKey = keyof CommandHandlerDeps;

export function buildCommandHandlerDeps(
  deps: CommandServiceDependencies,
): CommandHandlerDeps {
  return {
    run: deps,
    model: deps,
    tool: deps,
    hook: deps,
    debug: deps,
    memory: deps,
    skills: deps,
    workline: deps,
    bookmark: deps,
    executor: deps,
    session: deps,
    approval: deps,
    clear: deps,
  };
}

export function normalizeCommandDomain(
  request: CommandRequest,
): CommandDomainKey {
  if (request.domain === "work") {
    return "workline";
  }
  return request.domain;
}
