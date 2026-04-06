import type { LlmMessage, SkillManifest } from "../types.js";

export interface InputHistoryState {
  index: number | null;
  draft: string;
}

export interface InputCompletionResult {
  nextValue: string;
  hint?: string;
}

const STATIC_COMPLETIONS = [
  "/help",
  "/model status",
  "/model provider openai",
  "/model provider openrouter",
  "/model name ",
  "/model apikey ",
  "/tool status",
  "/tool confirm always",
  "/tool confirm risky",
  "/tool confirm never",
  "/memory list",
  "/memory show ",
  "/memory save ",
  "/skills list",
  "/skills show ",
  "/session status",
  "/session list",
  "/session log --limit=",
  "/session branch ",
  "/session fork ",
  "/session checkout ",
  "/session tag ",
  "/session merge ",
  "/agent status",
  "/agent interrupt",
  "/agent resume",
  "/clear",
  "/exit",
] as const;

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) {
    return "";
  }

  let prefix = values[0] ?? "";
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index] ?? "";
    while (!value.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) {
      break;
    }
  }

  return prefix;
}

export function extractUserInputHistory(messages: LlmMessage[]): string[] {
  return messages
    .filter((message): message is Extract<LlmMessage, { role: "user" }> => {
      return message.role === "user";
    })
    .map((message) => message.content.trim())
    .filter(Boolean);
}

export function navigateInputHistory(
  input: string,
  history: string[],
  state: InputHistoryState,
  direction: "up" | "down",
): { nextValue: string; nextState: InputHistoryState } {
  if (history.length === 0) {
    return {
      nextValue: input,
      nextState: state,
    };
  }

  if (direction === "up") {
    if (state.index === null) {
      return {
        nextValue: history[history.length - 1] ?? input,
        nextState: {
          index: history.length - 1,
          draft: input,
        },
      };
    }

    const nextIndex = Math.max(0, state.index - 1);
    return {
      nextValue: history[nextIndex] ?? input,
      nextState: {
        ...state,
        index: nextIndex,
      },
    };
  }

  if (state.index === null) {
    return {
      nextValue: input,
      nextState: state,
    };
  }

  if (state.index >= history.length - 1) {
    return {
      nextValue: state.draft,
      nextState: {
        index: null,
        draft: "",
      },
    };
  }

  const nextIndex = state.index + 1;
  return {
    nextValue: history[nextIndex] ?? input,
    nextState: {
      ...state,
      index: nextIndex,
    },
  };
}

export function buildAutocompleteCandidates(skills: SkillManifest[]): string[] {
  const dynamicCandidates = skills.map((skill) => `/skills show ${skill.name}`);
  return Array.from(new Set([...STATIC_COMPLETIONS, ...dynamicCandidates])).sort(
    (left, right) => left.localeCompare(right),
  );
}

export function completeInput(
  input: string,
  skills: SkillManifest[],
): InputCompletionResult {
  if (!input.startsWith("/")) {
    return {
      nextValue: input,
    };
  }

  const candidates = buildAutocompleteCandidates(skills).filter((candidate) => {
    return candidate.startsWith(input);
  });
  if (candidates.length === 0) {
    return {
      nextValue: input,
      hint: "没有可用补全。",
    };
  }

  if (candidates.length === 1) {
    const match = candidates[0] ?? input;
    return {
      nextValue: match,
      hint: match === input ? undefined : `补全: ${match}`,
    };
  }

  const prefix = longestCommonPrefix(candidates);
  return {
    nextValue: prefix.length > input.length ? prefix : input,
    hint: `候选: ${candidates.slice(0, 4).join(" | ")}`,
  };
}
