import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import type { AppController, AppState } from "../runtime/index.js";
import { ApprovalModal } from "./ApprovalModal.js";
import { InputBox } from "./InputBox.js";
import { MessageList } from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";
import {
  completeInput,
  extractUserInputHistory,
  navigateInputHistory,
  type InputHistoryState,
} from "./inputEnhancements.js";

interface AppProps {
  controller: AppController;
}

export function App({ controller }: AppProps) {
  const [state, setState] = useState<AppState>(controller.getState());
  const [input, setInput] = useState("");
  const [completionHint, setCompletionHint] = useState<string>();
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
    setInput("");
  }, [state.sessionId, state.sessionRef?.label]);

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

    if (key.upArrow) {
      const result = navigateInputHistory(input, inputHistory, historyState, "up");
      setInput(result.nextValue);
      setHistoryState(result.nextState);
      setCompletionHint(undefined);
      return;
    }

    if (key.downArrow) {
      const result = navigateInputHistory(input, inputHistory, historyState, "down");
      setInput(result.nextValue);
      setHistoryState(result.nextState);
      setCompletionHint(undefined);
      return;
    }

    if (key.tab) {
      const result = completeInput(input, state.availableSkills);
      setInput(result.nextValue);
      setCompletionHint(result.hint);
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

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">QAgent CLI v1</Text>
      <StatusBar
        sessionId={state.sessionId}
        sessionRefLabel={state.sessionRef?.label}
        shellCwd={state.shellCwd}
        approvalMode={state.approvalMode}
        status={state.status}
        skillCount={state.availableSkills.length}
      />
      {state.pendingApproval ? <ApprovalModal request={state.pendingApproval} /> : null}
      <MessageList
        messages={state.uiMessages}
        draftAssistantText={state.draftAssistantText}
      />
      <InputBox
        value={input}
        disabled={Boolean(state.pendingApproval)}
        completionHint={completionHint}
        onChange={handleChange}
        onSubmit={handleSubmit}
      />
      <Text color="gray">
        slash: /help | history: ↑/↓ | complete: Tab | approval: y/n | Ctrl+C:
        中断当前执行或退出
      </Text>
    </Box>
  );
}
