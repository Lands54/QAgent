import type {
  ApprovalMode,
  LlmMessage,
  PromptProfile,
  RuntimeConfig,
  SessionSnapshot,
  SessionWorkingHead,
  SkillManifest,
  UIMessage,
} from "../types.js";
import { HelperAgentCoordinator } from "./application/helperAgentCoordinator.js";

interface AutoMemoryForkCoordinator {
  getBaseSystemPrompt(): string | undefined;
  getRuntimeConfig(): RuntimeConfig;
  getRuntime(agentId: string): {
    getHead(): SessionWorkingHead;
    getSnapshot(): SessionSnapshot;
  };
  spawnTaskAgent(input: {
    name: string;
    sourceAgentId?: string;
    activate?: boolean;
    approvalMode?: ApprovalMode;
    promptProfile?: PromptProfile;
    autoMemoryFork?: boolean;
    retainOnCompletion?: boolean;
    mergeIntoAgentId?: string;
    mergeAssets?: string[];
    seedModelMessages?: LlmMessage[];
    seedUiMessages?: UIMessage[];
    lastUserPrompt?: string;
    buildRuntimeOverrides?: (head: SessionWorkingHead) => {
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
    },
  ): Promise<void>;
  cleanupCompletedAgent(agentId: string): Promise<void>;
  shouldAutoCleanupHelperAgent(): boolean;
}

export interface AutoMemoryForkInput {
  sourceAgentId: string;
  targetAgentId: string;
  targetSnapshot: SessionSnapshot;
  availableSkills: SkillManifest[];
  lastUserPrompt?: string;
  modelMessages: ReadonlyArray<LlmMessage>;
}

export interface AutoMemoryForkResult {
  report?: string;
  agentId: string;
}

function buildForkSystemPrompt(
  basePrompt: string | undefined,
): string {
  return [
    basePrompt ?? "",
    "你正在执行自动 memory fork 子任务。",
    "你的唯一目标是整理并沉淀上一轮 runLoop 的长期记忆。",
    "只允许通过 shell 在本次 fork head 的 memory overlay 中操作。",
    "优先写入 project memory；只有明显跨项目的经验才写入 global memory。",
    "在决定新建 memory 之前，你必须先检查现有 memory 目录与 `MEMORY.md`，优先把新信息整合进最匹配的现有 memory。",
    "只有在确实找不到合适的现有 memory，或现有 memory 无法合理承载该内容时，才允许新建新的 memory 目录。",
    "如果选择更新现有 memory，应尽量保留原目录与文件，只追加、改写或重组必要内容，不要无谓拆分出新的 memory。",
    "你必须严格遵守当前 memory 系统的目录结构约定。",
    "每条 memory 都必须存放为 `<memory-root>/<name>/MEMORY.md`，并可在同目录放置附属资产。",
    "`<name>` 必须使用 kebab-case，只能包含小写字母、数字与连字符。",
    "`MEMORY.md` 的 YAML frontmatter 必须且只能包含 `name` 与 `description` 两个字段。",
    "frontmatter 中的 `name` 必须等于目录名 `<name>`，`description` 必须是非空字符串。",
    "Markdown 正文就是该 memory 的内容本体，不要把正文再包进 JSON、YAML 或代码块容器。",
    "允许修改已有 memory 目录；如果新建 memory，必须新建一个合法目录并写入合法的 `MEMORY.md`。",
    "禁止创建旧格式 `*.json` memory 文件，禁止把 memory 直接写在 memory 根目录下。",
    "合法示例：",
    "```text",
    "memory/reply-language/MEMORY.md",
    "---",
    "name: reply-language",
    "description: 回复语言偏好",
    "---",
    "",
    "请默认使用中文回复。",
    "```",
    "shell 环境变量会提供 `QAGENT_PROJECT_MEMORY_DIR`、`QAGENT_GLOBAL_MEMORY_DIR` 与 `QAGENT_MEMORY_FORK_ROOT`。",
    "如果没有值得长期保留的内容，可以不写文件，但最终要明确说明没有新增记忆。",
    "不要触碰 memory overlay 之外的文件，也不要执行与记忆整理无关的命令。",
    "完成时请确保 memory 目录结构可被系统直接读取。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildForkUserPrompt(input: {
  lastUserPrompt?: string;
  projectMemoryDir: string;
  globalMemoryDir: string;
}): string {
  return [
    `当前时间：${new Date().toISOString()}`,
    `project memory 工作区：${input.projectMemoryDir}`,
    `global memory 工作区：${input.globalMemoryDir}`,
    "请总结上一轮 runLoop 中值得长期保留的记忆，并把结果写入当前 fork head 的 memory overlay。",
    input.lastUserPrompt ? `上一轮用户任务：${input.lastUserPrompt}` : "",
    "第一步先查看已有 memory 目录与 `MEMORY.md`，判断是否有合适的现有 memory 可直接更新。",
    "优先修改最匹配的现有 memory；只有没有合适项时，才新建新的 memory 目录。",
    "优先通过 shell 中的 `$QAGENT_PROJECT_MEMORY_DIR` / `$QAGENT_GLOBAL_MEMORY_DIR` 定位写入目录。",
    "在写入前请自检：目录名是否为 kebab-case，frontmatter 是否只有 `name`/`description`，且 `name` 是否与目录名一致。",
    "完成后请用一句话汇报你做了什么，以及为什么这样存。",
  ]
    .filter(Boolean)
    .join("\n");
}

export class AutoMemoryForkService {
  public constructor(private readonly agentManager: AutoMemoryForkCoordinator) {}

  public async run(input: AutoMemoryForkInput): Promise<AutoMemoryForkResult> {
    const helperCoordinator = new HelperAgentCoordinator(this.agentManager);
    const { agentId, result: report } = await helperCoordinator.run({
      name: `auto-memory-${Date.now()}`,
      sourceAgentId: input.sourceAgentId,
      activate: false,
      autoMemoryFork: false,
      retainOnCompletion: false,
      approvalMode: "never",
      mergeIntoAgentId: input.targetAgentId,
      mergeAssets: ["digest", "memory"],
      seedModelMessages: [...input.modelMessages],
      seedUiMessages: [],
      buildRuntimeOverrides: (head) => {
        const memoryState = head.assetState.memory as
          | {
              workspaceRoot?: string;
              projectMemoryDir?: string;
              globalMemoryDir?: string;
            }
          | undefined;
        if (!memoryState?.projectMemoryDir || !memoryState.globalMemoryDir) {
          throw new Error("自动 memory fork 缺少 memory asset state。");
        }
        return {
          promptProfile: "auto-memory",
          systemPrompt: buildForkSystemPrompt(
            this.agentManager.getBaseSystemPrompt(),
          ),
          maxAgentSteps:
            this.agentManager.getRuntimeConfig().runtime.autoMemoryForkMaxAgentSteps,
          environment: {
            QAGENT_MEMORY_FORK_ROOT: memoryState.workspaceRoot ?? "",
            QAGENT_PROJECT_MEMORY_DIR: memoryState.projectMemoryDir,
            QAGENT_GLOBAL_MEMORY_DIR: memoryState.globalMemoryDir,
          },
        };
      },
      buildPrompt: (runtime) => {
        const forkHead = runtime.getHead();
        const memoryState = forkHead.assetState.memory as
          | {
              projectMemoryDir?: string;
              globalMemoryDir?: string;
            }
          | undefined;
        if (!memoryState?.projectMemoryDir || !memoryState.globalMemoryDir) {
          throw new Error("自动 memory fork 缺少 memory asset state。");
        }
        return buildForkUserPrompt({
          lastUserPrompt: input.lastUserPrompt,
          projectMemoryDir: memoryState.projectMemoryDir,
          globalMemoryDir: memoryState.globalMemoryDir,
        });
      },
      submitOptions: {
        activate: false,
      },
      readResult: (runtime) => {
        return runtime
          .getSnapshot()
          .modelMessages
          .slice()
          .reverse()
          .find((message) => {
            return message.role === "assistant" && message.content.trim().length > 0;
          })?.content;
      },
    });

    return {
      report,
      agentId,
    };
  }
}
