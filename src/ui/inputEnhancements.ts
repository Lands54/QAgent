import type { LlmMessage, SkillManifest } from "../types.js";

export interface InputHistoryState {
  index: number | null;
  draft: string;
}

export interface CompletionSuggestion {
  value: string;
  displayValue?: string;
  description: string;
  category: "slash" | "skill";
}

export interface CompletionPreview {
  mode: "idle" | "chat" | "command";
  suggestions: CompletionSuggestion[];
  hint?: string;
}

export interface InputCompletionResult {
  nextValue: string;
  hint?: string;
  nextSuggestionIndex: number;
  cycleQuery?: string;
}

interface CompletionEntry extends CompletionSuggestion {
  featured?: boolean;
}

const STATIC_COMPLETIONS: CompletionEntry[] = [
  { value: "/help", description: "查看所有 slash 命令与说明", category: "slash", featured: true },
  { value: "/model status", description: "查看当前模型与 API 配置", category: "slash" },
  { value: "/model provider openai", description: "切换到 OpenAI provider", category: "slash" },
  { value: "/model provider openrouter", description: "切换到 OpenRouter provider", category: "slash" },
  { value: "/model name ", description: "设置模型名称", category: "slash" },
  { value: "/model apikey ", description: "写入模型 API Key", category: "slash" },
  { value: "/tool status", description: "查看工具审批模式", category: "slash" },
  { value: "/tool confirm always", description: "始终确认 shell 执行", category: "slash" },
  { value: "/tool confirm risky", description: "仅高风险命令确认", category: "slash" },
  { value: "/tool confirm never", description: "关闭工具审批", category: "slash" },
  { value: "/hook status", description: "查看 helper hooks 开关状态", category: "slash", featured: true },
  { value: "/hook fetch-memory on", description: "开启 fetch-memory hook", category: "slash" },
  { value: "/hook fetch-memory off", description: "关闭 fetch-memory hook", category: "slash" },
  { value: "/hook save-memory on", description: "开启 save-memory hook", category: "slash" },
  { value: "/hook save-memory off", description: "关闭 save-memory hook", category: "slash" },
  { value: "/hook auto-compact on", description: "开启 auto-compact hook", category: "slash" },
  { value: "/hook auto-compact off", description: "关闭 auto-compact hook", category: "slash" },
  { value: "/debug helper-agent status", description: "查看 helper agent 调试状态", category: "slash" },
  { value: "/debug ui-context status", description: "查看当前 agent 的 UI 上下文镜像状态", category: "slash" },
  { value: "/debug ui-context on", description: "开启 UI 消息按顺序进入模型上下文", category: "slash" },
  { value: "/debug ui-context off", description: "关闭 UI 消息进入模型上下文", category: "slash" },
  { value: "/debug helper-agent autocleanup on", description: "开启 helper agent 执行后自动清理", category: "slash" },
  { value: "/debug helper-agent autocleanup off", description: "关闭 helper agent 执行后自动清理", category: "slash" },
  { value: "/debug helper-agent clear", description: "清除当前 agent manager 中全部已结束的 helper agent", category: "slash" },
  { value: "/debug legacy clear", description: "清除当前 agent manager 中全部 legacy agent", category: "slash" },
  { value: "/memory list", description: "列出当前工作线可见的 memory", category: "slash", featured: true },
  { value: "/memory show ", description: "查看某条 memory", category: "slash" },
  { value: "/memory save --name= --description=", description: "手动保存一条 memory", category: "slash" },
  { value: "/skills list", description: "列出当前可用 Skills", category: "slash" },
  { value: "/skills show ", description: "查看 Skill 详情", category: "slash" },
  { value: "/work status", description: "查看当前工作线状态", category: "slash", featured: true },
  { value: "/work list", description: "列出所有工作线", category: "slash", featured: true },
  { value: "/work new ", displayValue: "/work new <name>", description: "新建并切换到工作线", category: "slash", featured: true },
  { value: "/work switch ", displayValue: "/work switch <worklineId|name>", description: "切换到某条工作线", category: "slash" },
  { value: "/work next", description: "切换到下一条工作线", category: "slash" },
  { value: "/work prev", description: "切换到上一条工作线", category: "slash" },
  { value: "/work detach", description: "让当前工作线脱离书签", category: "slash" },
  { value: "/work merge ", displayValue: "/work merge <sourceWorkline>", description: "合并另一条工作线的摘要资产", category: "slash" },
  { value: "/bookmark list", description: "列出全部书签", category: "slash", featured: true },
  { value: "/bookmark save ", displayValue: "/bookmark save <name>", description: "创建可写书签", category: "slash" },
  { value: "/bookmark tag ", displayValue: "/bookmark tag <name>", description: "创建只读书签", category: "slash" },
  { value: "/bookmark switch ", displayValue: "/bookmark switch <name>", description: "让当前工作线切到某个书签", category: "slash" },
  { value: "/bookmark merge ", displayValue: "/bookmark merge <sourceBookmark>", description: "合并某个书签的摘要资产", category: "slash" },
  { value: "/executor status", description: "查看当前执行器状态", category: "slash" },
  { value: "/executor list", description: "列出所有执行器", category: "slash" },
  { value: "/executor interrupt", description: "中断当前执行器", category: "slash" },
  { value: "/executor resume", description: "继续当前执行器", category: "slash" },
  { value: "/session commit -m ", displayValue: "/session commit -m \"<message>\"", description: "手动创建一条 session commit", category: "slash", featured: true },
  { value: "/session compact", description: "手动压缩当前会话上下文", category: "slash", featured: true },
  { value: "/session log --limit=", description: "查看 commit 历史", category: "slash" },
  { value: "/session graph log --limit=", description: "查看底层 session graph 节点日志", category: "slash" },
  { value: "/clear", description: "清空当前工作线的 UI 消息", category: "slash" },
  { value: "/exit", description: "退出 QAgent", category: "slash", featured: true },
] as const;

const DEFAULT_COMMANDS = STATIC_COMPLETIONS.filter((item) => item.featured).slice(0, 5);

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function renderSuggestionValue(entry: Pick<CompletionSuggestion, "value" | "displayValue">): string {
  return entry.displayValue ?? entry.value;
}

function scoreCompletionEntry(entry: CompletionEntry, query: string): number {
  if (!query) {
    return entry.featured ? 10_000 : 1_000;
  }

  const normalizedValue = entry.value.toLowerCase();
  const normalizedDisplayValue = renderSuggestionValue(entry).toLowerCase();
  const normalizedDescription = entry.description.toLowerCase();
  const tokens = query.split(/\s+/u).filter(Boolean);

  if (normalizedValue === query) {
    return 20_000;
  }
  if (normalizedDisplayValue === query) {
    return 19_000;
  }
  if (normalizedValue.startsWith(query)) {
    return 15_000 - normalizedValue.length;
  }
  if (normalizedDisplayValue.startsWith(query)) {
    return 14_000 - normalizedDisplayValue.length;
  }
  if (tokens.every((token) => normalizedValue.includes(token))) {
    return 9_000 - normalizedValue.length;
  }
  if (tokens.every((token) => normalizedDisplayValue.includes(token))) {
    return 8_500 - normalizedDisplayValue.length;
  }
  if (
    tokens.every((token) => {
      return (
        normalizedValue.includes(token)
        || normalizedDisplayValue.includes(token)
        || normalizedDescription.includes(token)
      );
    })
  ) {
    return 6_000 - normalizedValue.length;
  }
  if (normalizedValue.includes(query) || normalizedDisplayValue.includes(query)) {
    return 3_000 - normalizedValue.length;
  }
  return 0;
}

function dedupeCompletionEntries(
  entries: CompletionEntry[],
): CompletionEntry[] {
  const seen = new Set<string>();
  const deduped: CompletionEntry[] = [];

  for (const entry of entries) {
    if (seen.has(entry.value)) {
      continue;
    }
    seen.add(entry.value);
    deduped.push(entry);
  }

  return deduped;
}

export function extractUserInputHistory(
  messages: ReadonlyArray<LlmMessage>,
): string[] {
  return messages
    .filter((message): message is Extract<LlmMessage, { role: "user" }> => {
      return message.role === "user";
    })
    .map((message) => message.content.trim())
    .filter((content) => Boolean(content) && !content.startsWith("[UI命令] "));
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

export function buildAutocompleteEntries(
  skills: SkillManifest[],
): CompletionSuggestion[] {
  const dynamicEntries: CompletionEntry[] = skills.map((skill) => ({
    value: `/skills show ${skill.name}`,
    description: `查看 Skill：${skill.description || skill.name}`,
    category: "skill",
  }));

  return dedupeCompletionEntries([...STATIC_COMPLETIONS, ...dynamicEntries]).map(
    ({ value, displayValue, description, category }) => ({
      value,
      displayValue,
      description,
      category,
    }),
  );
}

export function buildAutocompleteCandidates(skills: SkillManifest[]): string[] {
  return buildAutocompleteEntries(skills).map((item) => item.value);
}

export function getCompletionPreview(
  input: string,
  skills: SkillManifest[],
  limit = 5,
): CompletionPreview {
  if (!input.trim()) {
    return {
      mode: "idle",
      suggestions: DEFAULT_COMMANDS.map(({ value, displayValue, description, category }) => ({
        value,
        displayValue,
        description,
        category,
      })).slice(0, limit),
      hint: "现在是待机态：直接说需求也行；想切到命令台，敲个 / 我就立刻进入认真脸。",
    };
  }

  if (!input.startsWith("/")) {
    return {
      mode: "chat",
      suggestions: [],
    };
  }

  const query = normalizeSearchText(input);
  const ranked = buildAutocompleteEntries(skills)
    .map((entry, index) => ({
      entry,
      score: scoreCompletionEntry(entry, query),
      index,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .slice(0, limit)
    .map((item) => item.entry);

  return {
    mode: "command",
    suggestions: ranked,
    hint:
      ranked.length > 0
        ? "Tab 补全首项，重复 Tab 可轮换候选。"
        : "没有可用补全。",
  };
}

export function completeInput(
  input: string,
  skills: SkillManifest[],
  currentSuggestionIndex = 0,
  cycleQuery?: string,
): InputCompletionResult {
  const lookupInput = cycleQuery ?? input;
  const preview = getCompletionPreview(lookupInput, skills, 8);
  if (preview.mode !== "command") {
    return {
      nextValue: input,
      nextSuggestionIndex: 0,
      cycleQuery: undefined,
    };
  }

  if (preview.suggestions.length === 0) {
    return {
      nextValue: input,
      hint: "没有可用补全。",
      nextSuggestionIndex: 0,
      cycleQuery: undefined,
    };
  }

  const prefixMatches = preview.suggestions.filter((suggestion) => {
    return suggestion.value.startsWith(lookupInput);
  });
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0] ?? preview.suggestions[0]!;
    return {
      nextValue: match.value,
      hint:
        match.value === input
          ? undefined
          : `补全: ${renderSuggestionValue(match)} · ${match.description}`,
      nextSuggestionIndex: 0,
      cycleQuery: undefined,
    };
  }

  if (!cycleQuery) {
    return {
      nextValue: input,
      hint: preview.hint,
      nextSuggestionIndex: 0,
      cycleQuery: input,
    };
  }

  const index = currentSuggestionIndex % preview.suggestions.length;
  const selected = preview.suggestions[index] ?? preview.suggestions[0]!;
  return {
    nextValue: selected.value,
    hint: `补全: ${renderSuggestionValue(selected)} · ${selected.description}`,
    nextSuggestionIndex: (index + 1) % preview.suggestions.length,
    cycleQuery,
  };
}
