import type {
  AgentViewState,
  ApprovalMode,
  BookmarkView,
  ExecutorView,
  SkillManifest,
  WorklineView,
} from "../../types.js";
import type { HeadAgentRuntime } from "../agentRuntime.js";
import { createEmptyState, type AgentStatus, type AppState } from "../appState.js";
import { ContextBudgetService } from "../domain/contextBudgetService.js";

interface BuildAppStateInput {
  cwd: string;
  previousState: AppState;
  activeRuntime: HeadAgentRuntime;
  activeView: AgentViewState;
  approvalMode: ApprovalMode;
  availableSkills: SkillManifest[];
  pendingApprovals: Record<string, NonNullable<AgentViewState["pendingApproval"]>>;
  agents: AgentViewState[];
  worklines: WorklineView[];
  executors: ExecutorView[];
  bookmarks: BookmarkView[];
  infoMessage?: string;
  autoCompactThresholdTokens: number;
}

function buildHelperActivities(agents: AgentViewState[]): string[] {
  return agents.flatMap((agent) => {
    if (
      agent.status !== "booting"
      && agent.status !== "running"
      && agent.status !== "awaiting-approval"
    ) {
      return [];
    }
    if (agent.helperType === "fetch-memory") {
      return ["fetching memory..."];
    }
    if (agent.helperType === "save-memory") {
      return ["saving memory..."];
    }
    if (agent.helperType === "compact-session") {
      return ["compacting session..."];
    }
    return [];
  });
}

export class AppStateAssembler {
  private readonly budgetService = new ContextBudgetService();

  public build(input: BuildAppStateInput): AppState {
    const snapshot = input.activeRuntime.getSnapshot();
    const budget = this.budgetService.summarize(
      snapshot.modelMessages,
      input.autoCompactThresholdTokens,
    );
    const pendingApproval = input.activeRuntime.getPendingApproval();
    const status: AgentStatus = {
      mode: input.activeView.status,
      detail: input.activeView.detail,
      updatedAt: new Date().toISOString(),
    };
    const baseState = createEmptyState(input.cwd);

    return {
      ...baseState,
      activeWorklineId: input.activeRuntime.headId,
      activeWorklineName: input.activeView.name,
      activeExecutorId: input.activeView.id,
      activeExecutorKind: input.activeView.kind,
      activeQueuedInputCount: input.activeView.queuedInputCount,
      activeBookmarkLabel: input.activeRuntime.getRef()?.label,
      worklines: input.worklines,
      executors: input.executors,
      bookmarks: input.bookmarks,
      activeAgentId: input.activeView.id,
      activeAgentKind: input.activeView.kind,
      activeWorkingHeadId: input.activeRuntime.headId,
      activeWorkingHeadName: input.activeView.name,
      sessionId: input.activeRuntime.sessionId,
      cwd: snapshot.cwd,
      shellCwd: input.activeView.shellCwd,
      approvalMode: input.approvalMode,
      status,
      uiMessages: [
        ...(input.infoMessage
          ? [
              {
                id: `ui-info-${Date.now()}`,
                role: "info" as const,
                content: input.infoMessage,
                createdAt: new Date().toISOString(),
              },
            ]
          : []),
        ...snapshot.uiMessages,
      ],
      draftAssistantText: input.activeRuntime.getDraftAssistantText(),
      modelMessages: [...snapshot.modelMessages],
      availableSkills: input.availableSkills,
      sessionRef: input.activeRuntime.getRef(),
      sessionHead: input.activeRuntime.getHead(),
      pendingApproval,
      pendingApprovals: input.pendingApprovals,
      agents: input.agents,
      shouldExit: input.previousState.shouldExit,
      lastUserPrompt: snapshot.lastUserPrompt,
      currentTokenEstimate: budget.currentTokens,
      autoCompactThresholdTokens: budget.thresholdTokens,
      helperActivities: buildHelperActivities(input.agents),
    };
  }
}
