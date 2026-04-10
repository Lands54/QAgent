import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import {
  isNextAgentShortcut,
  isPreviousAgentShortcut,
} from "./agentNavigationShortcuts.js";
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
import { WorklineList } from "./WorklineList.js";
import {
  buildSlashHelpText,
  type AppControllerLike,
  type AppState,
} from "../runtime/index.js";
import type { UIMessage } from "../types.js";

interface AppProps {
  controller: AppControllerLike;
}

function createLocalMessage(role: UIMessage["role"], content: string): UIMessage {
  return {
    id: `ui-local-${Date.now()}`,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

export function App({ controller }: AppProps) {
  const [state, setState] = useState<AppState>(controller.getState());
  const pendingStateRef = useRef<AppState>();
  const stateFlushTimerRef = useRef<NodeJS.Timeout>();
  const [input, setInput] = useState("");
  const [localError, setLocalError] = useState<string>();
  const [localMessages, setLocalMessages] = useState<UIMessage[]>([]);
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
    return controller.subscribe((nextState) => {
      pendingStateRef.current = nextState;
      if (stateFlushTimerRef.current) {
        return;
      }
      stateFlushTimerRef.current = setTimeout(() => {
        stateFlushTimerRef.current = undefined;
        if (pendingStateRef.current) {
          setState(pendingStateRef.current);
          pendingStateRef.current = undefined;
        }
      }, 33);
    });
  }, [controller]);

  useEffect(() => {
    return () => {
      if (stateFlushTimerRef.current) {
        clearTimeout(stateFlushTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setHistoryState({
      index: null,
      draft: "",
    });
    setCompletionHint(undefined);
    setCompletionSuggestionIndex(0);
    setCompletionCycleQuery(undefined);
    setLocalError(undefined);
    setLocalMessages([]);
    setInput("");
  }, [state.activeWorklineId, state.activeExecutorId, state.sessionId, state.activeBookmarkLabel]);

  useEffect(() => {
    if (state.shouldExit) {
      exit();
    }
  }, [exit, state.shouldExit]);

  useInput((value, key) => {
    const isCtrlC = value === "\x03" || (key.ctrl && value.toLowerCase() === "c");
    if (state.pendingApproval) {
      if (isCtrlC) {
        runControllerAction(controller.interruptAgent(), "取消审批流程失败");
        return;
      }
      if (value.toLowerCase() === "y") {
        runControllerAction(controller.approvePendingRequest(true), "批准请求失败");
      }
      if (value.toLowerCase() === "n" || key.escape) {
        runControllerAction(controller.approvePendingRequest(false), "拒绝请求失败");
      }
      return;
    }

    if (isPreviousAgentShortcut(value, key)) {
      if (state.worklines.length > 1) {
        runControllerAction(controller.switchAgentRelative(-1), "切换工作线失败");
      }
      return;
    }

    if (isNextAgentShortcut(value, key)) {
      if (state.worklines.length > 1) {
        runControllerAction(controller.switchAgentRelative(1), "切换工作线失败");
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

    if (isCtrlC) {
      if (state.status.mode === "running" || state.status.mode === "awaiting-approval") {
        runControllerAction(controller.interruptAgent(), "中断执行失败");
      } else {
        requestLocalExit();
      }
    }
  });

  function handleChange(nextValue: string) {
    setInput(nextValue);
    setLocalError(undefined);
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
    setLocalError(undefined);
    setHistoryState({
      index: null,
      draft: "",
    });
    if (!trimmed) {
      setInput("");
      return;
    }
    if (handleLocalSlashCommand(trimmed)) {
      setInput("");
      return;
    }
    runControllerAction(controller.submitInput(trimmed), "发送输入失败");
    setInput("");
  }

  function handleLocalSlashCommand(trimmed: string): boolean {
    if (trimmed === "/help") {
      appendLocalMessage("info", buildSlashHelpText());
      return true;
    }
    if (trimmed === "/exit") {
      requestLocalExit();
      return true;
    }
    return false;
  }

  function requestLocalExit(): void {
    const exitAction = controller.requestExit();
    exit();
    runControllerAction(exitAction, "退出失败");
  }

  function appendLocalMessage(role: UIMessage["role"], content: string): void {
    setLocalMessages((messages) => [
      ...messages,
      createLocalMessage(role, content),
    ]);
  }

  function runControllerAction(
    action: Promise<void>,
    fallbackMessage: string,
  ): void {
    void action.catch((error) => {
      setLocalError(formatActionError(error, fallbackMessage));
    });
  }

  function formatActionError(error: unknown, fallbackMessage: string): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }
    return fallbackMessage;
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
        queuedInputCount={state.activeQueuedInputCount}
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
      <Box>
        <MessageList
          messages={[...state.uiMessages, ...localMessages]}
          draftAssistantText={state.draftAssistantText}
        />
      </Box>
      {localError ? <Text color="red">{localError}</Text> : null}
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
