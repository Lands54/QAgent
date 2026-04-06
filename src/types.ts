export type ApprovalMode = "always" | "risky" | "never";
export type SkillScope = "project" | "global";
export type ToolName = "shell";
export type ModelProvider = "openai" | "openrouter";

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
    systemPrompt?: string;
    appName?: string;
    appUrl?: string;
  };
  runtime: {
    maxAgentSteps: number;
    shellCommandTimeoutMs: number;
    maxToolOutputChars: number;
    maxConversationSummaryMessages: number;
  };
  tool: {
    approvalMode: ApprovalMode;
    shellExecutable: string;
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
  initialPrompt?: string;
  resumeSessionId?: string;
  help?: boolean;
}

export interface InstructionLayer {
  id: string;
  source:
    | "base"
    | "global-agent"
    | "project-agent"
    | "skill-catalog"
    | "memory"
    | "session-summary";
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
  title: string;
  content: string;
  tags: string[];
  keywords: string[];
  scope: SkillScope;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  path: string;
}

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "info" | "error";
  content: string;
  createdAt: string;
  title?: string;
}

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

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionSnapshot {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  shellCwd: string;
  approvalMode: ApprovalMode;
  uiMessages: UIMessage[];
  modelMessages: LlmMessage[];
  lastUserPrompt?: string;
  lastRunSummary?: string;
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
  kind: "root" | "checkpoint" | "merge";
  workingSessionId: string;
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

export interface SessionRepoState {
  version: 1;
  currentBranchName?: string;
  detachedTagName?: string;
  detachedNodeId?: string;
  headNodeId: string;
  workingSessionId: string;
  defaultBranchName: "main";
}

export interface SessionRefInfo {
  mode: "branch" | "detached-tag" | "detached-node";
  name: string;
  label: string;
  headNodeId: string;
  workingSessionId: string;
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
  messages: LlmMessage[];
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

export interface SlashCommandResult {
  handled: boolean;
  exitRequested?: boolean;
  clearUi?: boolean;
  interruptAgent?: boolean;
  resumeAgent?: boolean;
  messages: UIMessage[];
}
