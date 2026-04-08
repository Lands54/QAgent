import type {
  InstructionLayer,
  LlmMessage,
  MemoryRecord,
  PromptProfile,
  RuntimeConfig,
  SkillManifest,
  ToolMode,
} from "../types.js";
import { createId, truncate } from "../utils/index.js";

interface AssemblePromptInput {
  config: RuntimeConfig;
  profile?: PromptProfile;
  agentLayers: InstructionLayer[];
  availableSkills: SkillManifest[];
  relevantMemories: MemoryRecord[];
  modelMessages: ReadonlyArray<LlmMessage>;
  shellCwd: string;
  toolMode?: ToolMode;
}

function baseInstruction(
  config: RuntimeConfig,
  toolMode: ToolMode,
): InstructionLayer {
  const sharedLines = [
    config.model.systemPrompt ?? "",
    "工作方式约束：",
    "- 你是运行在终端中的 Agent。",
  ];
  const toolLines =
    toolMode === "none"
      ? [
          "- 当前回合不暴露任何工具。",
          "- 你必须仅根据已有上下文直接输出文本结果。",
        ]
      : [
          "- 你只能使用一个名为 shell 的工具。",
          "- shell 仅适用于非交互式命令；不要请求需要全屏 TTY、持续 stdin 或编辑器的命令。",
          "- 在没有必要时，优先直接回答，不要滥用工具。",
        ];
  const content = [...sharedLines, ...toolLines]
    .filter(Boolean)
    .join("\n");

  return {
    id: createId("instruction"),
    source: "base",
    title: "基础运行规则",
    content,
    priority: 1000,
  };
}

function skillCatalogLayer(
  availableSkills: SkillManifest[],
  config: RuntimeConfig,
): InstructionLayer | undefined {
  if (availableSkills.length === 0) {
    return undefined;
  }

  const yamlLines = ["skills:"];
  for (const skill of availableSkills) {
    yamlLines.push(`  - name: ${JSON.stringify(skill.name)}`);
    yamlLines.push(`    description: ${JSON.stringify(skill.description)}`);
  }

  return {
    id: createId("instruction"),
    source: "skill-catalog",
    title: "可用 Skill 元数据",
    content: [
      "以下 YAML 是当前可用的全部 Skill 元信息索引。这里不会自动注入每个 Skill 的正文内容。",
      "当某个任务需要某个 Skill 时，你应当使用 shell 进入对应 skill 目录，自行读取该 skill 的 `SKILL.md`，并按需使用该目录中的 `scripts/`、`references/`、`assets/` 等资源。",
      "技能目录定位规则：`name` 必须等于技能目录名。",
      `项目技能根目录：${config.resolvedPaths.projectSkillsDir}`,
      `全局技能根目录：${config.resolvedPaths.globalSkillsDir}`,
      "```yaml",
      ...yamlLines,
      "```",
    ].join("\n"),
    priority: 85,
  };
}

function _memoryLayers(relevantMemories: MemoryRecord[]): InstructionLayer[] {
  return relevantMemories.map((memory, index) => ({
    id: createId("instruction"),
    source: "memory",
    title: `记忆：${memory.name}`,
    content: [
      "以下是与当前任务相关的 memory 索引与摘要，不会自动注入完整正文。",
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `scope: ${memory.scope}`,
      `path: ${memory.path}`,
      "摘要：",
      truncate(memory.content || "(empty)", 240),
      "如需完整内容或附属资产，请使用 shell 读取该 memory 目录中的 `MEMORY.md` 与其他文件。",
    ].join("\n"),
    priority: 70 - index,
  }));
}

function _sessionDigestLayer(
  messages: ReadonlyArray<LlmMessage>,
  maxMessages: number,
): InstructionLayer | undefined {
  const relevant = messages.slice(-maxMessages);
  if (relevant.length === 0) {
    return undefined;
  }

  const digest = relevant
    .map((message) => {
      if (message.role === "tool") {
        return `[tool:${message.name}] ${truncate(message.content, 800)}`;
      }
      return `[${message.role}] ${truncate(message.content, 800)}`;
    })
    .join("\n");

  return {
    id: createId("instruction"),
    source: "session-digest",
    title: "最近会话摘要",
    content: digest,
    priority: 60,
  };
}

export interface AssembledPrompt {
  systemPrompt: string;
  layers: InstructionLayer[];
}

export class PromptAssembler {
  public assemble(input: AssemblePromptInput): AssembledPrompt {
    const profile = input.profile ?? "default";
    const layers = [
      baseInstruction(input.config, input.toolMode ?? "shell"),
      ...input.agentLayers,
      profile === "default"
        ? skillCatalogLayer(input.availableSkills, input.config)
        : undefined,
    ]
      .filter((layer): layer is InstructionLayer => Boolean(layer))
      .sort((left, right) => right.priority - left.priority);

    const systemPrompt = layers
      .map((layer) => `## ${layer.title}\n${layer.content}`)
      .join("\n\n");

    return {
      systemPrompt,
      layers,
    };
  }
}
