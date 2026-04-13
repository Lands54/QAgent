export type ApprovalMode = "always" | "risky" | "never";
export type SkillScope = "project" | "global";
export type ToolName = "shell";
export type ModelProvider = "openai" | "openrouter";
export type AgentKind = "interactive" | "task";
export type TransportMode = "local" | "remote";
export type HelperAgentType =
  | "fetch-memory"
  | "save-memory"
  | "compact-session";
export type PromptProfile =
  | "default"
  | "auto-memory"
  | "fetch-memory"
  | "compact-session";
export type ToolMode = "shell" | "none";
export type AgentLifecycleStatus =
  | "booting"
  | "idle"
  | "running"
  | "awaiting-approval"
  | "interrupted"
  | "error"
  | "completed"
  | "closed";

export interface ResolvedPaths {
  cwd: string;
  homeDir: string;
  globalAgentDir: string;
  projectRoot: string;
  projectAgentDir: string;
  globalConfigPath: string;
  projectConfigPath: string;
  explicitConfigPath?: string;
  globalMemoryDir: string;
  projectMemoryDir: string;
  globalSkillsDir: string;
  projectSkillsDir: string;
  sessionRoot: string;
}

export interface RuntimeConfig {
  cwd: string;
  resolvedPaths: ResolvedPaths;
  model: {
    provider: ModelProvider;
    baseUrl: string;
    apiKey?: string;
    model: string;
    temperature: number;
    maxTokens?: number;
    requestTimeoutMs?: number;
    systemPrompt?: string;
    appName?: string;
    appUrl?: string;
  };
  runtime: {
    maxAgentSteps: number;
    fetchMemoryMaxAgentSteps: number;
    autoMemoryForkMaxAgentSteps: number;
    shellCommandTimeoutMs: number;
    maxToolOutputChars: number;
    maxConversationSummaryMessages: number;
    autoCompactThresholdTokens: number;
    compactRecentKeepGroups: number;
  };
  tool: {
    approvalMode: ApprovalMode;
    shellExecutable: string;
  };
  gateway: {
    transportMode: TransportMode;
    workspaceId?: string;
    edgeBaseUrl?: string;
    apiToken?: string;
  };
  edge: {
    bindHost: string;
    port: number;
  };
  cli: {
    initialPrompt?: string;
    resumeSessionId?: string;
    explicitConfigPath?: string;
  };
}

export interface CliOptions {
  cwd?: string;
  configPath?: string;
  provider?: ModelProvider;
  model?: string;
  transportMode?: TransportMode;
  workspaceId?: string;
  edgeBaseUrl?: string;
  apiToken?: string;
  edgeBindHost?: string;
  edgePort?: number;
  initialPrompt?: string;
  resumeSessionId?: string;
  help?: boolean;
}

export interface EdgeManifest {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: string;
  updatedAt: string;
  version: string;
  buildSha: string;
}

export interface GatewayHealthSummary {
  clientCount: number;
  leaseCount: number;
  localBaseUrl: string;
  lastUpdatedAt: string;
}

export interface WorkspaceRegistration {
  workspaceId: string;
  sessionRoot: string;
  pid: number;
  version: string;
  buildSha: string;
  capabilities: string[];
  connectedAt: string;
  lastSeenAt: string;
  health: GatewayHealthSummary;
}

export interface GatewayConnectionState {
  workspaceId: string;
  online: boolean;
  sessionRoot?: string;
  pid?: number;
  version?: string;
  buildSha?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  health?: GatewayHealthSummary;
}

export interface RemoteClientSession {
  clientId: string;
  workspaceId: string;
  clientLabel: "cli" | "tui" | "api";
  createdAt: string;
  lastSeenAt: string;
}

export interface EdgeGatewayCommandEnvelope {
  commandId: string;
  clientId: string;
  executorId?: string;
  request: CommandRequest;
}

export type EdgeGatewayRpcAction =
  | {
      kind: "openClient";
      payload: {
        clientId?: string;
        clientLabel: "cli" | "tui" | "api";
      };
    }
  | {
      kind: "closeClient";
      payload: {
        clientId: string;
      };
    }
  | {
      kind: "getState";
      payload: {
        clientId: string;
      };
    }
  | {
      kind: "submitInput";
      payload: {
        clientId: string;
        input: string;
      };
    }
  | {
      kind: "executeCommand";
      payload: EdgeGatewayCommandEnvelope;
    }
  | {
      kind: "openExecutor";
      payload: {
        clientId: string;
        worklineId?: string;
      };
    }
  | {
      kind: "heartbeatExecutor";
      payload: {
        executorId: string;
        clientId: string;
      };
    }
  | {
      kind: "releaseExecutor";
      payload: {
        executorId: string;
        clientId?: string;
      };
    }
  | {
      kind: "stopGateway";
      payload: {
        reason?: string;
      };
    };

export interface GatewayRegisterMessage {
  type: "gateway.register";
  requestId: string;
  payload: {
    workspaceId: string;
    sessionRoot: string;
    pid: number;
    version: string;
    buildSha: string;
    capabilities: string[];
    health: GatewayHealthSummary;
  };
}

export interface GatewayRegisteredMessage {
  type: "gateway.registered";
  requestId: string;
  payload: {
    workspaceId: string;
    connectedAt: string;
  };
}

export interface EdgeGatewayRpcRequest {
  type: "gateway.rpc.request";
  requestId: string;
  workspaceId: string;
  action: EdgeGatewayRpcAction;
}

export type EdgeGatewayRpcResult =
  | {
      type: "gateway.rpc.result";
      requestId: string;
      workspaceId: string;
      ok: true;
      payload: unknown;
    }
  | {
      type: "gateway.rpc.result";
      requestId: string;
      workspaceId: string;
      ok: false;
      error: string;
    };

export interface GatewayEventEnvelope {
  type: "gateway.event";
  workspaceId: string;
  event: unknown;
}

export interface GatewayHealthEnvelope {
  type: "gateway.health";
  workspaceId: string;
  payload: GatewayHealthSummary;
}

export type EdgeGatewaySocketMessage =
  | GatewayRegisterMessage
  | GatewayRegisteredMessage
  | EdgeGatewayRpcRequest
  | EdgeGatewayRpcResult
  | GatewayEventEnvelope
  | GatewayHealthEnvelope;

export interface EdgeHealthResponse {
  ok: true;
  pid: number;
  baseUrl: string;
  workspaceCount: number;
  version: string;
  buildSha: string;
}

export type CommandDomain =
  | "run"
  | "model"
  | "tool"
  | "hook"
  | "debug"
  | "memory"
  | "skills"
  | "work"
  | "bookmark"
  | "executor"
  | "session"
  | "approval"
  | "clear";

export interface CommandMessage {
  level: "info" | "error";
  text: string;
  title?: string;
}

export interface PendingApprovalResumeState {
  step: number;
  toolCalls: ReadonlyArray<ToolCall>;
  nextToolCallIndex: number;
}

export interface PendingApprovalCheckpoint {
  checkpointId: string;
  executorId: string;
  worklineId: string;
  agentId: string;
  headId: string;
  sessionId: string;
  toolCall: ToolCall;
  approvalRequest: ApprovalRequest;
  assistantMessageId: string;
  createdAt: string;
  resumeState: PendingApprovalResumeState;
}

export type CommandRequest =
  | {
      domain: "run";
      prompt: string;
      agentId?: string;
      modelInputAppendix?: string;
    }
  | {
      domain: "model";
      action: "status" | "provider" | "name" | "apikey";
      provider?: ModelProvider;
      model?: string;
      apiKey?: string;
    }
  | {
      domain: "tool";
      action: "status" | "confirm";
      mode?: ApprovalMode;
    }
  | {
      domain: "hook";
      action: "status" | "fetch-memory" | "save-memory" | "auto-compact";
      enabled?: boolean;
    }
  | {
      domain: "debug";
      action:
        | "helper-agent-status"
        | "helper-agent-autocleanup"
        | "helper-agent-clear"
        | "legacy-clear"
        | "ui-context-status"
        | "ui-context-set";
      enabled?: boolean;
    }
  | {
      domain: "memory";
      action: "list" | "show" | "save";
      name?: string;
      description?: string;
      content?: string;
      scope?: SkillScope;
    }
  | {
      domain: "skills";
      action: "list" | "show";
      key?: string;
    }
  | {
      domain: "work";
      action:
        | "status"
        | "list"
        | "switch"
        | "next"
        | "prev"
        | "close"
        | "new"
        | "detach"
        | "merge";
      worklineId?: string;
      name?: string;
      source?: string;
    }
  | {
      domain: "bookmark";
      action:
        | "list"
        | "save"
        | "tag"
        | "switch"
        | "merge"
        | "status";
      name?: string;
      bookmark?: string;
      source?: string;
    }
  | {
      domain: "executor";
      action: "status" | "list" | "interrupt" | "resume";
      executorId?: string;
    }
  | {
      domain: "session";
      action:
        | "compact"
        | "commit"
        | "log"
        | "graph-log"
        | "reset-context";
      message?: string;
      limit?: number;
    }
  | {
      domain: "approval";
      action: "status" | "approve" | "reject";
      checkpointId?: string;
      agentId?: string;
      headId?: string;
    }
  | {
      domain: "clear";
    };

export type CommandResultStatus =
  | "success"
  | "validation_error"
  | "runtime_error"
  | "approval_required";

export interface CommandResultBase<TStatus extends CommandResultStatus = CommandResultStatus> {
  status: TStatus;
  code: string;
  exitCode: number;
  messages: ReadonlyArray<CommandMessage>;
  payload?: unknown;
}

export type CommandResult =
  | CommandResultBase<"success">
  | CommandResultBase<"validation_error">
  | CommandResultBase<"runtime_error">
  | (CommandResultBase<"approval_required"> & {
      payload: {
        checkpoint: PendingApprovalCheckpoint;
        uiMessages?: ReadonlyArray<UIMessage>;
      };
    });

export interface RuntimeEventBase<
  TType extends string,
  TPayload extends object,
> {
  id: string;
  type: TType;
  createdAt: string;
  commandId?: string;
  clientId?: string;
  sessionId: string;
  worklineId: string;
  executorId: string;
  headId: string;
  agentId: string;
  payload: TPayload;
}

export type StatusChangedRuntimeEvent = RuntimeEventBase<
  "status.changed",
  {
    status: AgentLifecycleStatus;
    detail: string;
  }
>;

export type AssistantDeltaRuntimeEvent = RuntimeEventBase<
  "assistant.delta",
  {
    delta: string;
    text: string;
  }
>;

export type AssistantCompletedRuntimeEvent = RuntimeEventBase<
  "assistant.completed",
  {
    assistantMessageId: string;
    content: string;
    toolCalls: ReadonlyArray<ToolCall>;
  }
>;

export type ToolStartedRuntimeEvent = RuntimeEventBase<
  "tool.started",
  {
    toolCall: ToolCall;
  }
>;

export type ToolFinishedRuntimeEvent = RuntimeEventBase<
  "tool.finished",
  {
    result: ToolResult;
  }
>;

export type ToolOutputDeltaRuntimeEvent = RuntimeEventBase<
  "tool.output.delta",
  {
    callId: string;
    command: string;
    stream: "stdout" | "stderr";
    chunk: string;
    cwd: string;
    startedAt: string;
  }
>;

export type ApprovalRequiredRuntimeEvent = RuntimeEventBase<
  "approval.required",
  {
    checkpoint: PendingApprovalCheckpoint;
  }
>;

export type ApprovalResolvedRuntimeEvent = RuntimeEventBase<
  "approval.resolved",
  {
    checkpointId: string;
    approved: boolean;
    requestId: string;
    toolCall: ToolCall;
  }
>;

export type SessionChangedRuntimeEvent = RuntimeEventBase<
  "session.changed",
  {
    action: string;
    ref?: SessionRefInfo;
  }
>;

export type WorklineChangedRuntimeEvent = RuntimeEventBase<
  "workline.changed",
  {
    action: string;
    workline?: WorklineView;
  }
>;

export type CommandCompletedRuntimeEvent = RuntimeEventBase<
  "command.completed",
  {
    domain: CommandDomain;
    status: CommandResultStatus;
    code: string;
    result: CommandResult;
  }
>;

export type RuntimeWarningRuntimeEvent = RuntimeEventBase<
  "runtime.warning",
  {
    message: string;
    source: "post-run.auto-memory-fork" | "state.refresh";
  }
>;

export type RuntimeErrorRuntimeEvent = RuntimeEventBase<
  "runtime.error",
  {
    message: string;
  }
>;

export type RuntimeEvent =
  | StatusChangedRuntimeEvent
  | AssistantDeltaRuntimeEvent
  | AssistantCompletedRuntimeEvent
  | ToolStartedRuntimeEvent
  | ToolOutputDeltaRuntimeEvent
  | ToolFinishedRuntimeEvent
  | ApprovalRequiredRuntimeEvent
  | ApprovalResolvedRuntimeEvent
  | SessionChangedRuntimeEvent
  | WorklineChangedRuntimeEvent
  | CommandCompletedRuntimeEvent
  | RuntimeWarningRuntimeEvent
  | RuntimeErrorRuntimeEvent;

export interface InstructionLayer {
  id: string;
  source:
    | "base"
    | "global-agent"
    | "project-agent"
    | "skill-catalog"
    | "memory"
    | "session-digest";
  title: string;
  content: string;
  priority: number;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  directoryPath: string;
  filePath: string;
  content: string;
}

export interface MemoryRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  keywords: string[];
  scope: SkillScope;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  directoryPath: string;
  path: string;
}

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "info" | "error";
  content: string;
  createdAt: string;
  title?: string;
}

export type ConversationEntryKind =
  | "user-input"
  | "assistant-turn"
  | "tool-result"
  | "ui-command"
  | "ui-result"
  | "system-info"
  | "system-error"
  | "compact-summary";

export interface ToolCall {
  id: string;
  name: ToolName;
  createdAt: string;
  input: {
    command: string;
    reasoning?: string;
  };
}

export interface ToolResult {
  callId: string;
  name: ToolName;
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

export interface ApprovalRequest {
  id: string;
  toolCall: ToolCall;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  createdAt: string;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  decidedAt: string;
  reason?: string;
}

export type LlmMessage =
  | {
      id: string;
      role: "user";
      content: string;
      createdAt: string;
    }
  | {
      id: string;
      role: "assistant";
      content: string;
      createdAt: string;
      toolCalls?: ToolCall[];
    }
  | {
      id: string;
      role: "tool";
      content: string;
      createdAt: string;
      toolCallId: string;
      name: ToolName;
    };

export interface ConversationEntry {
  id: string;
  kind: ConversationEntryKind;
  createdAt: string;
  ui?: UIMessage;
  model?: LlmMessage;
  modelMirror?: LlmMessage;
}

export interface SessionEventBase<
  TType extends string,
  TPayload extends object,
> {
  id: string;
  workingHeadId: string;
  sessionId: string;
  type: TType;
  timestamp: string;
  payload: TPayload;
}

export interface SessionCreatedPayload {
  cwd: string;
  shellCwd: string;
}

export interface ConversationEntryAppendedPayload {
  entryKind: ConversationEntryKind;
  entry: ConversationEntry;
}

export interface ConversationLastUserPromptSetPayload {
  prompt: string;
}

export type ConversationUiClearedPayload = Record<string, never>;

export interface ConversationModelContextResetPayload {
  resetEntryIds: string[];
}

export interface RuntimeUiContextSetPayload {
  enabled: boolean;
}

export interface AgentStatusSetPayload {
  mode: AgentLifecycleStatus;
  detail: string;
}

export interface ConversationCompactedPayload {
  reason: "manual" | "auto";
  beforeTokens: number;
  afterTokens: number;
  keptGroups: number;
  removedGroups: number;
  summaryAgentId?: string;
  compactedEntryIds: string[];
  summaryEntryId: string;
}

export type SessionCreatedEvent = SessionEventBase<
  "session.created",
  SessionCreatedPayload
>;

export type ConversationEntryAppendedEvent = SessionEventBase<
  "conversation.entry.appended",
  ConversationEntryAppendedPayload
>;

export type ConversationLastUserPromptSetEvent = SessionEventBase<
  "conversation.last_user_prompt.set",
  ConversationLastUserPromptSetPayload
>;

export type ConversationUiClearedEvent = SessionEventBase<
  "conversation.ui.cleared",
  ConversationUiClearedPayload
>;

export type ConversationModelContextResetEvent = SessionEventBase<
  "conversation.model_context.reset",
  ConversationModelContextResetPayload
>;

export type RuntimeUiContextSetEvent = SessionEventBase<
  "runtime.ui_context.set",
  RuntimeUiContextSetPayload
>;

export type AgentStatusSetEvent = SessionEventBase<
  "agent.status.set",
  AgentStatusSetPayload
>;

export type ConversationCompactedEvent = SessionEventBase<
  "conversation.compacted",
  ConversationCompactedPayload
>;

export type SessionEvent =
  | SessionCreatedEvent
  | ConversationEntryAppendedEvent
  | ConversationLastUserPromptSetEvent
  | ConversationUiClearedEvent
  | ConversationModelContextResetEvent
  | RuntimeUiContextSetEvent
  | AgentStatusSetEvent
  | ConversationCompactedEvent;

export interface SessionSnapshot {
  workingHeadId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
  /**
   * 会话消息的单一事实来源。
   * 所有普通对话与 UI-only 事件都应先写入这里，再投影出 UI / model 视图。
   */
  conversationEntries: ReadonlyArray<ConversationEntry>;
  /**
   * 从 conversationEntries 投影出的 UI 视图缓存。
   * 兼容现有读取方而保留；不要把它当作主数据直接修改。
   */
  uiMessages: ReadonlyArray<UIMessage>;
  /**
   * 从 conversationEntries 投影出的模型上下文缓存。
   * 兼容现有读取方而保留；不要把它当作主数据直接修改。
   */
  modelMessages: ReadonlyArray<LlmMessage>;
  lastUserPrompt?: string;
  lastRunSummary?: string;
  /**
   * UI 视图的清屏水位线，只影响 uiMessages 投影，不影响 conversationEntries。
   */
  uiClearedAt?: string;
}

export interface SessionAbstractAsset {
  id: string;
  title: string;
  content: string;
  tags: string[];
  sourceNodeIds: string[];
  createdAt: string;
}

export interface SessionNode {
  id: string;
  parentNodeIds: string[];
  kind: "root" | "checkpoint" | "compact" | "merge";
  snapshot: SessionSnapshot;
  abstractAssets: SessionAbstractAsset[];
  snapshotHash: string;
  createdAt: string;
}

export interface SessionBranchRef {
  name: string;
  headNodeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionTagRef {
  name: string;
  targetNodeId: string;
  createdAt: string;
}

export interface SessionCommitRecord {
  id: string;
  message: string;
  nodeId: string;
  headId: string;
  sessionId: string;
  createdAt: string;
}

export type SessionAttachmentMode = "branch" | "tag" | "detached-node";

export type SessionHeadAttachment =
  | {
      mode: "branch";
      name: string;
      nodeId: string;
    }
  | {
      mode: "tag";
      name: string;
      nodeId: string;
    }
  | {
      mode: "detached-node";
      name: string;
      nodeId: string;
    };

export interface SessionWriterLease {
  branchName: string;
  acquiredAt: string;
}

export interface SessionRuntimeState {
  shellCwd: string;
  agentKind?: AgentKind;
  autoMemoryFork?: boolean;
  retainOnCompletion?: boolean;
  promptProfile?: PromptProfile;
  toolMode?: ToolMode;
  uiContextEnabled?: boolean;
  status?: "idle" | "running" | "awaiting-approval" | "interrupted" | "error" | "closed";
}

export interface SessionWorkingHead {
  id: string;
  name: string;
  currentNodeId: string;
  sessionId: string;
  attachment: SessionHeadAttachment;
  writerLease?: SessionWriterLease;
  runtimeState: SessionRuntimeState;
  assetState: Record<string, unknown>;
  status: "idle" | "running" | "awaiting-approval" | "interrupted" | "error" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface SessionRepoState {
  version: 2;
  activeWorkingHeadId: string;
  defaultBranchName: "main";
  createdAt: string;
  updatedAt: string;
}

export interface SessionRefInfo {
  mode: "branch" | "detached-tag" | "detached-node";
  name: string;
  label: string;
  headNodeId: string;
  workingHeadId: string;
  workingHeadName: string;
  sessionId: string;
  writerLeaseBranch?: string;
  active: boolean;
  dirty: boolean;
}

export interface SessionListItem {
  name: string;
  targetNodeId: string;
  current: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface SessionListView {
  branches: SessionListItem[];
  tags: SessionListItem[];
}

export interface SessionCommitListItem extends SessionCommitRecord {
  current: boolean;
}

export interface SessionCommitListView {
  commits: SessionCommitListItem[];
}

export interface SessionHeadListItem {
  id: string;
  name: string;
  sessionId: string;
  attachmentLabel: string;
  currentNodeId: string;
  writerLeaseBranch?: string;
  active: boolean;
  status: SessionWorkingHead["status"];
  dirty: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionHeadListView {
  heads: SessionHeadListItem[];
}

export interface BookmarkView {
  name: string;
  kind: "branch" | "tag";
  targetNodeId: string;
  current: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface BookmarkListView {
  bookmarks: BookmarkView[];
}

export interface AgentRecord {
  id: string;
  headId: string;
  sessionId: string;
  name: string;
  kind: AgentKind;
  helperType?: HelperAgentType;
  status: AgentLifecycleStatus;
  autoMemoryFork: boolean;
  retainOnCompletion: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentViewState extends AgentRecord {
  detail: string;
  sessionRefLabel?: string;
  shellCwd: string;
  dirty: boolean;
  pendingApproval?: ApprovalRequest;
  queuedInputCount: number;
  lastUserPrompt?: string;
}

export interface WorklineView {
  id: string;
  sessionId: string;
  name: string;
  attachmentMode: SessionRefInfo["mode"];
  attachmentLabel: string;
  shellCwd: string;
  dirty: boolean;
  writeLock?: string;
  status: AgentLifecycleStatus;
  detail: string;
  executorKind?: AgentKind;
  helperType?: HelperAgentType;
  pendingApproval?: ApprovalRequest;
  queuedInputCount: number;
  lastUserPrompt?: string;
  active: boolean;
}

export interface WorklineListView {
  worklines: WorklineView[];
}

export interface ExecutorView extends AgentViewState {
  executorId: string;
  worklineId: string;
  worklineName: string;
  active: boolean;
}

export interface ExecutorListView {
  executors: ExecutorView[];
}

export interface SessionLogEntry {
  id: string;
  kind: SessionNode["kind"];
  parentNodeIds: string[];
  refs: string[];
  summaryTitle?: string;
  createdAt: string;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelTurnRequest {
  systemPrompt: string;
  messages: ReadonlyArray<LlmMessage>;
  tools: ToolDefinition[];
}

export interface ModelTurnResult {
  assistantText: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface ModelStreamHooks {
  onTextStart?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextComplete?: (text: string) => void;
}

export interface ModelClient {
  runTurn(
    request: ModelTurnRequest,
    hooks?: ModelStreamHooks,
    signal?: AbortSignal,
  ): Promise<ModelTurnResult>;
}

export interface SessionAssetForkInput {
  head: SessionWorkingHead;
  sessionRoot: string;
  snapshot: SessionSnapshot;
  sourceHead?: SessionWorkingHead;
  sourceState?: unknown;
}

export interface SessionAssetCheckpointInput {
  head: SessionWorkingHead;
  state: unknown;
  snapshot: SessionSnapshot;
  sessionRoot: string;
}

export interface SessionAssetRestoreInput {
  head: SessionWorkingHead;
  state: unknown;
  sessionRoot: string;
}

export interface SessionAssetMergeInput {
  targetHead: SessionWorkingHead;
  sourceHead: SessionWorkingHead;
  targetState: unknown;
  sourceState: unknown;
  targetSnapshot: SessionSnapshot;
  sourceSnapshot: SessionSnapshot;
  sessionRoot: string;
}

export interface SessionAssetMergeResult {
  targetState: unknown;
  mergeAssets?: SessionAbstractAsset[];
}

export interface SessionAssetProvider {
  kind: string;
  fork(input: SessionAssetForkInput): Promise<unknown>;
  checkpoint(input: SessionAssetCheckpointInput): Promise<unknown>;
  restore?(input: SessionAssetRestoreInput): Promise<void>;
  merge(input: SessionAssetMergeInput): Promise<SessionAssetMergeResult>;
}

export interface SlashCommandResult {
  handled: boolean;
  exitRequested?: boolean;
  clearUi?: boolean;
  interruptAgent?: boolean;
  resumeAgent?: boolean;
  messages: ReadonlyArray<UIMessage>;
}
