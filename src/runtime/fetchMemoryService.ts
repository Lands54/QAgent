import type {
  LlmMessage,
  PromptProfile,
  RuntimeConfig,
  SessionSnapshot,
  SessionWorkingHead,
} from "../types.js";
import { truncate } from "../utils/index.js";
import { HelperAgentCoordinator } from "./application/helperAgentCoordinator.js";

interface FetchMemoryRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  path: string;
  scope: "project" | "global";
}

interface FetchMemoryCoordinator {
  getBaseSystemPrompt(): string | undefined;
  getRuntimeConfig(): RuntimeConfig;
  getRuntime(agentId: string): {
    getHead(): SessionWorkingHead;
    getSnapshot(): SessionSnapshot;
    listMemory(limit?: number): Promise<FetchMemoryRecord[]>;
  };
  spawnTaskAgent(input: {
    name: string;
    sourceAgentId?: string;
    activate?: boolean;
    approvalMode?: "always" | "risky" | "never";
    promptProfile?: PromptProfile;
    autoMemoryFork?: boolean;
    retainOnCompletion?: boolean;
    buildRuntimeOverrides?: () => {
      promptProfile?: PromptProfile;
      systemPrompt?: string;
      maxAgentSteps?: number;
      environment?: Record<string, string>;
    };
  }): Promise<{ id: string }>;
  submitInputToAgent(
    agentId: string,
    input: string,
    options?: {
      activate?: boolean;
      skipFetchMemoryHook?: boolean;
    },
  ): Promise<void>;
  cleanupCompletedAgent(agentId: string): Promise<void>;
  shouldAutoCleanupHelperAgent(): boolean;
}

export interface FetchMemoryInput {
  sourceAgentId: string;
  userPrompt: string;
}

const FETCH_MEMORY_MAX_CANDIDATES = 24;
const FETCH_MEMORY_MAX_SELECTIONS = 3;

function buildFetchMemorySystemPrompt(basePrompt: string | undefined): string {
  return [
    basePrompt ?? "",
    "你正在执行 fetch-memory 子任务。",
    "你的唯一目标是从候选 memory 中挑选最适合当前用户请求、且尚未出现在历史中的 0 到 3 条 memory。",
    "你只能选择候选清单里已有的 memory name，不能发明新的 memory。",
    "如有必要，你可以使用 shell 只读查看候选 `MEMORY.md`；禁止修改任何文件。",
    "最终回答必须是严格 JSON，格式为：",
    '{"selectedMemoryNames":["memory-a","memory-b"]}',
    "如果没有合适 memory，返回：",
    '{"selectedMemoryNames":[]}',
    "不要输出 JSON 以外的任何解释、Markdown 或代码块。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRecentHistoryDigest(messages: ReadonlyArray<LlmMessage>): string {
  const relevant = messages.slice(-8);
  if (relevant.length === 0) {
    return "无";
  }

  return relevant
    .map((message) => {
      if (message.role === "tool") {
        return `[tool:${message.name}] ${truncate(message.content, 160)}`;
      }
      return `[${message.role}] ${truncate(message.content, 160)}`;
    })
    .join("\n");
}

function buildCandidateCatalog(records: FetchMemoryRecord[]): string {
  return records
    .map((record) => {
      return [
        `- name: ${record.name}`,
        `  scope: ${record.scope}`,
        `  description: ${record.description}`,
        `  path: ${record.path}`,
        `  excerpt: ${JSON.stringify(truncate(record.content, 180))}`,
      ].join("\n");
    })
    .join("\n");
}

function buildFetchMemoryUserPrompt(
  input: FetchMemoryInput,
  historyDigest: string,
  candidates: FetchMemoryRecord[],
): string {
  return [
    `当前时间：${new Date().toISOString()}`,
    "当前用户请求：",
    input.userPrompt.trim(),
    "",
    "最近对话摘录：",
    historyDigest,
    "",
    "候选 memory（这些 memory 尚未出现在历史中）：",
    buildCandidateCatalog(candidates),
    "",
    "请从中选择最适合当前请求的 0 到 3 条 memory。",
    "如果 excerpt 不足以判断，可用 shell 只读查看对应 `MEMORY.md`。",
    "记住：最终只能输出严格 JSON。",
  ].join("\n");
}

function isMemoryReferencedInHistory(
  historyText: string,
  record: FetchMemoryRecord,
): boolean {
  const lowered = historyText.toLowerCase();
  const signatures = [
    record.path.toLowerCase(),
    record.name.toLowerCase(),
    `name: ${record.name}`.toLowerCase(),
    `memory/${record.name}/memory.md`.toLowerCase(),
  ];
  return signatures.some((signature) => lowered.includes(signature));
}

function parseSelectedMemoryNames(
  content: string,
  candidates: FetchMemoryRecord[],
): string[] {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/u);
  const objectText =
    fencedMatch?.[1]
    ?? trimmed.match(/\{[\s\S]*\}/u)?.[0]
    ?? trimmed;

  try {
    const parsed = JSON.parse(objectText) as {
      selectedMemoryNames?: unknown;
    };
    const allowed = new Set(candidates.map((item) => item.name));
    return Array.isArray(parsed.selectedMemoryNames)
      ? parsed.selectedMemoryNames
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => allowed.has(item))
          .slice(0, FETCH_MEMORY_MAX_SELECTIONS)
      : [];
  } catch {
    return [];
  }
}

function buildMemoryAppendix(records: FetchMemoryRecord[]): string {
  if (records.length === 0) {
    return "";
  }

  return [
    "以下是系统自动补充的 Memory.md 参考（这些文件此前未出现在历史中）：",
    ...records.flatMap((record) => [
      `### MEMORY.md: ${record.name}`,
      `path: ${record.path}`,
      `scope: ${record.scope}`,
      "```md",
      "---",
      `name: ${record.name}`,
      `description: ${record.description}`,
      "---",
      "",
      record.content,
      "```",
    ]),
  ].join("\n");
}

export class FetchMemoryService {
  public constructor(private readonly agentManager: FetchMemoryCoordinator) {}

  public async run(input: FetchMemoryInput): Promise<string | undefined> {
    const runtime = this.agentManager.getRuntime(input.sourceAgentId);
    const snapshot = runtime.getSnapshot();
    const allMemories = await runtime.listMemory(FETCH_MEMORY_MAX_CANDIDATES * 2);
    const historyText = snapshot.modelMessages.map((message) => message.content).join("\n");
    const candidates = allMemories
      .filter((record) => !isMemoryReferencedInHistory(historyText, record))
      .slice(0, FETCH_MEMORY_MAX_CANDIDATES);

    if (candidates.length === 0) {
      return undefined;
    }

    const fetchPrompt = buildFetchMemoryUserPrompt(
      input,
      buildRecentHistoryDigest(snapshot.modelMessages),
      candidates,
    );
    const helperCoordinator = new HelperAgentCoordinator(this.agentManager);
    const { result: report } = await helperCoordinator.run({
      name: `fetch-memory-${Date.now()}`,
      sourceAgentId: input.sourceAgentId,
      activate: false,
      approvalMode: "never",
      promptProfile: "fetch-memory",
      autoMemoryFork: false,
      retainOnCompletion: false,
      buildRuntimeOverrides: () => ({
        promptProfile: "fetch-memory",
        systemPrompt: buildFetchMemorySystemPrompt(
          this.agentManager.getBaseSystemPrompt(),
        ),
        maxAgentSteps:
          this.agentManager.getRuntimeConfig().runtime.fetchMemoryMaxAgentSteps,
      }),
      buildPrompt: () => fetchPrompt,
      submitOptions: {
        activate: false,
        skipFetchMemoryHook: true,
      },
      readResult: (fetchRuntime) => {
        return fetchRuntime
          .getSnapshot()
          .modelMessages
          .slice()
          .reverse()
          .find((message) => {
            return message.role === "assistant" && message.content.trim().length > 0;
          })?.content;
      },
    });
    if (!report) {
      return undefined;
    }

    const selectedNames = parseSelectedMemoryNames(report, candidates);
    if (selectedNames.length === 0) {
      return undefined;
    }

    const selectedRecords = selectedNames
      .map((name) => candidates.find((record) => record.name === name))
      .filter((record): record is FetchMemoryRecord => Boolean(record));
    if (selectedRecords.length === 0) {
      return undefined;
    }

    return buildMemoryAppendix(selectedRecords);
  }
}
