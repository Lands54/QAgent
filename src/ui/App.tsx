import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";

import { ApprovalModal } from "./ApprovalModal.js";
import { WorklineList } from "./WorklineList.js";
import {
  isNextAgentShortcut,
  isPreviousAgentShortcut,
} from "./agentNavigationShortcuts.js";
import { InputBox } from "./InputBox.js";
import {
  completeInput,
  extractUserInputHistory,
  getCompletionPreview,
  navigateInputHistory,
  type InputHistoryState,
} from "./inputEnhancements.js";
import { MessageList } from "./MessageList.js";
import { buildFooterHint } from "./presentation/footerHint.js";
import { StatusBar } from "./StatusBar.js";
import type { AppControllerLike, AppState } from "../runtime/index.js";

interface AppProps {
  controller: AppControllerLike;
}

export function App({ controller }: AppProps) {
  const [state, setState] = useState<AppState>(controller.getState());
  const [input, setInput] = useState("");
  const [completionHint, setCompletionHint] = useState<string>();
  const [completionSuggestionIndex, setCompletionSuggestionIndex] = useState(0);
  const [completionCycleQuery, setCompletionCycleQuery] = useState<string>();
  const [historyState, setHistoryState] = useState<InputHistoryState>({
    index: null,
    draft: "",
  });
  const { exit } = useApp();
  const inputHistory = extractUserInputHistory(state.modelMessages);

  useEffect(() => {
    return controller.subscribe(setState);
  }, [controller]);

  useEffect(() => {
    setHistoryState({
      index: null,
      draft: "",
    });
    setCompletionHint(undefined);
    setCompletionSuggestionIndex(0);
    setCompletionCycleQuery(undefined);
    setInput("");
  }, [state.activeWorklineId, state.activeExecutorId, state.sessionId, state.activeBookmarkLabel]);

  useEffect(() => {
    if (state.shouldExit) {
      exit();
    }
  }, [exit, state.shouldExit]);

  useInput((value, key) => {
    if (state.pendingApproval) {
      if (key.ctrl && value.toLowerCase() === "c") {
        void controller.interruptAgent();
        return;
      }
      if (value.toLowerCase() === "y") {
        void controller.approvePendingRequest(true);
      }
      if (value.toLowerCase() === "n" || key.escape) {
        void controller.approvePendingRequest(false);
      }
      return;
    }

    if (isPreviousAgentShortcut(value, key)) {
      if (state.worklines.length > 1) {
        void controller.switchAgentRelative(-1);
      }
      return;
    }

    if (isNextAgentShortcut(value, key)) {
      if (state.worklines.length > 1) {
        void controller.switchAgentRelative(1);
      }
      return;
    }

    if (key.upArrow) {
      const result = navigateInputHistory(input, inputHistory, historyState, "up");
      setInput(result.nextValue);
      setHistoryState(result.nextState);
      setCompletionHint(undefined);
      setCompletionCycleQuery(undefined);
      setCompletionSuggestionIndex(0);
      return;
    }

    if (key.downArrow) {
      const result = navigateInputHistory(input, inputHistory, historyState, "down");
      setInput(result.nextValue);
      setHistoryState(result.nextState);
      setCompletionHint(undefined);
      setCompletionCycleQuery(undefined);
      setCompletionSuggestionIndex(0);
      return;
    }

    if (key.tab) {
      const result = completeInput(
        input,
        state.availableSkills,
        completionSuggestionIndex,
        completionCycleQuery,
      );
      setInput(result.nextValue);
      setCompletionHint(result.hint);
      setCompletionSuggestionIndex(result.nextSuggestionIndex);
      setCompletionCycleQuery(result.cycleQuery);
      setHistoryState({
        index: null,
        draft: "",
      });
      return;
    }

    if (key.ctrl && value.toLowerCase() === "c") {
      if (state.status.mode === "running" || state.status.mode === "awaiting-approval") {
        void controller.interruptAgent();
      } else {
        void controller.requestExit();
      }
    }
  });

  function handleChange(nextValue: string) {
    setInput(nextValue);
    setCompletionHint(undefined);
    setCompletionSuggestionIndex(0);
    setCompletionCycleQuery(undefined);
    if (historyState.index !== null) {
      setHistoryState({
        index: null,
        draft: "",
      });
    }
  }

  function handleSubmit(nextValue: string) {
    const trimmed = nextValue.trim();
    setCompletionHint(undefined);
    setCompletionSuggestionIndex(0);
    setCompletionCycleQuery(undefined);
    setHistoryState({
      index: null,
      draft: "",
    });
    if (!trimmed) {
      setInput("");
      return;
    }
    void controller.submitInput(trimmed);
    setInput("");
  }

  const completionPreview = getCompletionPreview(
    completionCycleQuery ?? input,
    state.availableSkills,
  );
  const footerHint = buildFooterHint({
    currentTokenEstimate: state.currentTokenEstimate,
    autoCompactThresholdTokens: state.autoCompactThresholdTokens,
    worklineCount: state.worklines.length,
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">QAgent CLI v1</Text>
      <StatusBar
        executorKind={state.activeExecutorKind}
        worklineId={state.activeWorklineId}
        worklineName={state.activeWorklineName}
        sessionId={state.sessionId}
        bookmarkLabel={state.activeBookmarkLabel}
        shellCwd={state.shellCwd}
        approvalMode={state.approvalMode}
        status={state.status}
        skillCount={state.availableSkills.length}
        worklineCount={state.worklines.length}
      />
      <WorklineList worklines={state.worklines} activeWorklineId={state.activeWorklineId} />
      {state.helperActivities.length > 0 ? (
        <Text color="cyan">helper: {state.helperActivities.join(" | ")}</Text>
      ) : null}
      {state.pendingApproval ? <ApprovalModal request={state.pendingApproval} /> : null}
      <MessageList
        messages={state.uiMessages}
        draftAssistantText={state.draftAssistantText}
      />
      <InputBox
        value={input}
        disabled={Boolean(state.pendingApproval)}
        completionHint={completionHint ?? completionPreview.hint}
        completionMode={completionPreview.mode}
        completionSuggestions={completionPreview.suggestions}
        completionSelectedIndex={completionSuggestionIndex}
        onChange={handleChange}
        onSubmit={handleSubmit}
      />
      <Text color="gray">{footerHint}</Text>
    </Box>
  );
}
