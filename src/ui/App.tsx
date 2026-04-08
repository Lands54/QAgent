import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";

import { AgentList } from "./AgentList.js";
import { ApprovalModal } from "./ApprovalModal.js";
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
import type { AppController, AppState } from "../runtime/index.js";

interface AppProps {
  controller: AppController;
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
  }, [state.activeAgentId, state.activeWorkingHeadId, state.sessionId, state.sessionRef?.label]);

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

    if (key.ctrl && value.toLowerCase() === "p") {
      if (state.agents.length > 1) {
        void controller.switchAgentRelative(-1);
      }
      return;
    }

    if (key.ctrl && value.toLowerCase() === "n") {
      if (state.agents.length > 1) {
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

  async function handleSubmit(nextValue: string) {
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
    await controller.submitInput(trimmed);
    setInput("");
  }

  const completionPreview = getCompletionPreview(
    completionCycleQuery ?? input,
    state.availableSkills,
  );
  const footerHint = buildFooterHint({
    currentTokenEstimate: state.currentTokenEstimate,
    autoCompactThresholdTokens: state.autoCompactThresholdTokens,
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">QAgent CLI v1</Text>
      <StatusBar
        agentKind={state.activeAgentKind}
        workingHeadId={state.activeWorkingHeadId}
        workingHeadName={state.activeWorkingHeadName}
        sessionId={state.sessionId}
        sessionRefLabel={state.sessionRef?.label}
        shellCwd={state.shellCwd}
        approvalMode={state.approvalMode}
        status={state.status}
        queuedInputCount={state.queuedInputCount}
        skillCount={state.availableSkills.length}
        agentCount={state.agents.length}
      />
      <AgentList agents={state.agents} activeAgentId={state.activeAgentId} />
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
