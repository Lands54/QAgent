import type {
  InstructionLayer,
  LlmMessage,
  MemoryRecord,
  RuntimeConfig,
  SkillManifest,
} from "../types.js";
import { createId, truncate } from "../utils/index.js";

interface AssemblePromptInput {
  config: RuntimeConfig;
  agentLayers: InstructionLayer[];
  availableSkills: SkillManifest[];
  relevantMemories: MemoryRecord[];
  modelMessages: LlmMessage[];
  shellCwd: string;
}

function baseInstruction(config: RuntimeConfig, shellCwd: string): InstructionLayer {
  const content = [
    config.model.systemPrompt ?? "",
    "工作方式约束：",
    "- 你是运行在终端中的 Agent。",
    "- 你只能使用一个名为 shell 的工具。",
    "- shell 仅适用于非交互式命令；不要请求需要全屏 TTY、持续 stdin 或编辑器的命令。",
    "- 在没有必要时，优先直接回答，不要滥用工具。",
    `- 当前 shell 工作目录：${shellCwd}`,
    `- 当前工具审批模式：${config.tool.approvalMode}`,
    `- 当前最大自治步数：${config.runtime.maxAgentSteps}`,
    `- 当前时间：${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: createId("instruction"),
    source: "base",
    title: "Base Runtime Rules",
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
    title: "Available Skill Metadata",
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

function memoryLayers(relevantMemories: MemoryRecord[]): InstructionLayer[] {
  return relevantMemories.map((memory, index) => ({
    id: createId("instruction"),
    source: "memory",
    title: `Memory: ${memory.title}`,
    content: [
      `标题：${memory.title}`,
      `标签：${memory.tags.join(", ") || "无"}`,
      "内容：",
      memory.content,
    ].join("\n"),
    priority: 70 - index,
  }));
}

function sessionSummaryLayer(
  messages: LlmMessage[],
  maxMessages: number,
): InstructionLayer | undefined {
  const relevant = messages.slice(-maxMessages);
  if (relevant.length === 0) {
    return undefined;
  }

  const summary = relevant
    .map((message) => {
      if (message.role === "tool") {
        return `[tool:${message.name}] ${truncate(message.content, 800)}`;
      }
      return `[${message.role}] ${truncate(message.content, 800)}`;
    })
    .join("\n");

  return {
    id: createId("instruction"),
    source: "session-summary",
    title: "Recent Session Summary",
    content: summary,
    priority: 60,
  };
}

export interface AssembledPrompt {
  systemPrompt: string;
  layers: InstructionLayer[];
}

export class PromptAssembler {
  public assemble(input: AssemblePromptInput): AssembledPrompt {
    const layers = [
      baseInstruction(input.config, input.shellCwd),
      ...input.agentLayers,
      skillCatalogLayer(input.availableSkills, input.config),
      ...memoryLayers(input.relevantMemories),
      sessionSummaryLayer(
        input.modelMessages,
        input.config.runtime.maxConversationSummaryMessages,
      ),
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
