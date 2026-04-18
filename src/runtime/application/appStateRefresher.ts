import type {
  AgentViewState,
  ApprovalMode,
  BookmarkView,
  ExecutorView,
  SessionLogEntry,
  SkillManifest,
  WorklineView,
} from "../../types.js";
import type { HeadAgentRuntime } from "../agentRuntime.js";
import type { AppState } from "../appState.js";
import { AppStateAssembler } from "./appStateAssembler.js";

export interface AppStateSource {
  getActiveRuntime(): HeadAgentRuntime;
  listAgents(): AgentViewState[];
  listWorklines(): {
    worklines: WorklineView[];
  };
  listExecutors(): {
    executors: ExecutorView[];
  };
}

export interface BuildAppStateFromSourceInput {
  cwd: string;
  previousState: AppState;
  stateSource: AppStateSource;
  approvalMode: ApprovalMode;
  availableSkills: SkillManifest[];
  infoMessage?: string;
  autoCompactThresholdTokens: number;
  activeRuntime?: HeadAgentRuntime;
  worklines?: WorklineView[];
  executors?: ExecutorView[];
  bookmarks?: BookmarkView[];
  sessionGraphEntries?: SessionLogEntry[];
}

export type AppStateSupplementalState = Pick<AppState, "bookmarks" | "sessionGraphEntries">;

export interface AppStateSupplementalFailure {
  component: "bookmarks" | "sessionGraph";
  error: unknown;
}

export interface LoadAppStateSupplementalInput {
  fallbackState: AppStateSupplementalState;
  loadBookmarks: () => Promise<BookmarkView[]>;
  loadSessionGraphEntries: () => Promise<SessionLogEntry[]>;
  onPartialFailure?: (failure: AppStateSupplementalFailure) => void | Promise<void>;
}

function collectPendingApprovals(
  agents: AgentViewState[],
): Record<string, NonNullable<AgentViewState["pendingApproval"]>> {
  return Object.fromEntries(
    agents
      .filter((agent) => agent.pendingApproval)
      .map((agent) => [agent.id, agent.pendingApproval as NonNullable<typeof agent.pendingApproval>]),
  );
}

export class AppStateRefresher {
  private readonly assembler = new AppStateAssembler();

  public buildState(input: BuildAppStateFromSourceInput): AppState {
    const activeRuntime = input.activeRuntime ?? input.stateSource.getActiveRuntime();
    const agents = input.stateSource.listAgents();

    return this.assembler.build({
      cwd: input.cwd,
      previousState: input.previousState,
      activeRuntime,
      activeView: activeRuntime.getViewState(),
      approvalMode: input.approvalMode,
      availableSkills: input.availableSkills,
      pendingApprovals: collectPendingApprovals(agents),
      agents,
      worklines: input.worklines ?? input.stateSource.listWorklines().worklines,
      executors: input.executors ?? input.stateSource.listExecutors().executors,
      bookmarks: input.bookmarks ?? input.previousState.bookmarks,
      sessionGraphEntries: input.sessionGraphEntries ?? input.previousState.sessionGraphEntries,
      infoMessage: input.infoMessage,
      autoCompactThresholdTokens: input.autoCompactThresholdTokens,
    });
  }

  public async loadSupplementalState(
    input: LoadAppStateSupplementalInput,
  ): Promise<AppStateSupplementalState> {
    const [bookmarksResult, sessionGraphResult] = await Promise.allSettled([
      input.loadBookmarks(),
      input.loadSessionGraphEntries(),
    ]);

    if (bookmarksResult.status === "rejected") {
      await input.onPartialFailure?.({
        component: "bookmarks",
        error: bookmarksResult.reason,
      });
    }
    if (sessionGraphResult.status === "rejected") {
      await input.onPartialFailure?.({
        component: "sessionGraph",
        error: sessionGraphResult.reason,
      });
    }

    return {
      bookmarks: bookmarksResult.status === "fulfilled"
        ? bookmarksResult.value
        : input.fallbackState.bookmarks,
      sessionGraphEntries: sessionGraphResult.status === "fulfilled"
        ? sessionGraphResult.value
        : input.fallbackState.sessionGraphEntries,
    };
  }
}
