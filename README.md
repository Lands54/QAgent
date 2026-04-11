# QAgent

一个基于 `TypeScript + React + Ink` 的终端 Agent CLI。

## 特性

- 单一 Tool 设计：模型侧只暴露 `shell`
- `Skill` 系统：启动时汇总全部 Skill 的 `name/description` 元信息，使用时通过 shell 直接访问 Skill 目录
- `Memory` 系统：基于 session asset overlay 的持久化、检索注入与自动 fork 总结
- `AGENT.md / AGENTS.md` 注入：支持全局与项目级规则
- 斜杠命令：不经过模型，直接操作控制面
- 持久 shell 会话：支持 `cd` 和上下文延续
- Session V2：多 working head、branch 单写者、并发隔离与 asset merge

## 快速开始

```bash
npm install
npm run build
node bin/qagent.js --help
```

如果要接入模型，至少提供以下之一：

- `QAGENT_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

可选环境变量：

- `QAGENT_PROVIDER`
- `QAGENT_BASE_URL`
- `QAGENT_MODEL`
- `QAGENT_APP_NAME`
- `QAGENT_APP_URL`
- `OPENROUTER_BASE_URL`
- `OPENROUTER_APP_NAME`
- `OPENROUTER_SITE_URL`
- `QAGENT_SHELL`
- `QAGENT_MAX_AGENT_STEPS`
- `QAGENT_FETCH_MEMORY_MAX_AGENT_STEPS`
- `QAGENT_AUTO_MEMORY_FORK_MAX_AGENT_STEPS`
- `QAGENT_SHELL_TIMEOUT_MS`
- `QAGENT_AUTO_COMPACT_THRESHOLD_TOKENS`
- `QAGENT_COMPACT_RECENT_KEEP_GROUPS`

`provider` 目前支持：

- `openai`
- `openrouter`

`OpenRouter` 默认使用 `https://openrouter.ai/api/v1`，并自动附带 `X-OpenRouter-Title` 请求头；如果配置了 `QAGENT_APP_URL` 或 `OPENROUTER_SITE_URL`，也会附带 `HTTP-Referer`。

## 目录约定

```text
.agent/
  config.json
  skills/
  memory/
  sessions/
src/
  cli/
  ui/
  runtime/
  tool/
  model/
  memory/
  skills/
  session/
  context/
```

## 运行方式

```bash
qagent
qagent "帮我看看当前项目结构"
qagent resume
qagent resume <sessionId>
qagent --cwd /path/to/project --model gpt-4.1-mini
qagent --provider openrouter --model openai/gpt-4.1-mini
```

## 斜杠命令

- `/help`
- `/model status`
- `/model provider <openai|openrouter>`
- `/model name <model>`
- `/model apikey <key>`
- `/tool status`
- `/tool confirm <always|risky|never>`
- `/hook status`
- `/hook fetch-memory <on|off>`
- `/hook save-memory <on|off>`
- `/hook auto-compact <on|off>`
- `/debug helper-agent status`
- `/debug helper-agent autocleanup <on|off>`
- `/debug helper-agent clear`
- `/debug legacy clear`
- `/memory save [--global] --name=<name> --description=<说明> <内容>`
- `/memory list`
- `/memory show <name>`
- `/skills list`
- `/skills show <name|id>`
- `/session status`
- `/session compact`
- `/session reset-context`
- `/session list`
- `/session log [--limit=N]`
- `/session branch <name>`
- `/session fork <name>`
- `/session checkout <ref>`
- `/session tag <name>`
- `/session merge <sourceRef>`
- `/session head status`
- `/session head list`
- `/session head fork <name>`
- `/session head switch <headId>`
- `/session head attach <headId> <ref>`
- `/session head detach <headId>`
- `/session head merge <sourceHeadId>`
- `/session head close <headId>`
- `/agent status [agentId|name]`
- `/agent list`
- `/agent switch <agentId|name>`
- `/agent next`
- `/agent prev`
- `/agent close <agentId|name>`
- `/agent interrupt`
- `/agent resume`
- `/clear`
- `/exit`

UI 小技巧：

- `Ctrl+P` / `Ctrl+N` 可以在 agent 之间快速切换
- `fetch-memory`、`save-memory` 与 `compact-session` helper agent 会在运行期间显示在 Agents 面板中；默认完成后会自动清理
- 可以通过 `/debug helper-agent autocleanup <on|off>` 临时控制 helper agent 是否在执行后直接消亡，并通过 `/debug helper-agent clear` 清理当前 manager 中的 helper agent
- 遇到 v1 迁移残留的 `legacy-*` working head 时，可以通过 `/debug legacy clear` 统一清理

模型配置说明：

- `/model provider` 与 `/model name` 会写入项目级 `.agent/config.json`
- `/model apikey` 会写入全局 `~/.agent/config.json`，避免把密钥直接写进项目配置
- helper agent 的最大行动次数也支持通过 `.agent/config.json` 或环境变量配置：
  - `runtime.fetchMemoryMaxAgentSteps`
  - `runtime.autoMemoryForkMaxAgentSteps`
  - `QAGENT_FETCH_MEMORY_MAX_AGENT_STEPS`
  - `QAGENT_AUTO_MEMORY_FORK_MAX_AGENT_STEPS`

Skill 机制说明：

- 每个 Skill 是一个目录，至少包含一个 `SKILL.md`
- 每个 `SKILL.md` 包含 YAML frontmatter + Markdown 正文
- 当前实现会在每轮上下文构建时收集所有 Skill 的 `name/description`，合成为一段统一的 YAML 元信息索引注入上下文
- 不会自动把所有 Skill 的正文注入上下文
- Agent 需要使用某个 Skill 时，应通过 `shell` 直接读取对应 Skill 目录中的 `SKILL.md`、`scripts/`、`references/`、`assets/` 等内容

Memory 机制说明：

- 每个 working head 都持有自己隔离的 memory overlay
- `/memory list|show|save` 默认操作 active head 的 memory overlay
- 每条 memory 是一个目录，结构为 `memory/<name>/MEMORY.md` 与其他附属资产
- 每个 `MEMORY.md` 必须包含 YAML frontmatter，且仅包含 `name`、`description` 两个字段
- 当前实现只会把相关 memory 的 `name/description/path` 与正文摘录注入 prompt，不会自动注入完整正文
- Agent 需要使用完整 memory 时，应通过 `shell` 直接读取对应 memory 目录中的 `MEMORY.md` 与其他资产
- 每次主 `runLoop` 正常结束后，会自动 `forkHead` 一个 detached memory head 来整理上一轮记忆
- detached memory head 结束后，会通过 `mergeHeadIntoHead(..., [\"digest\", \"memory\"])` 合回目标 head

Compact 机制说明：

- `compact v1` 只压缩 `modelMessages`，不会折叠已有 `uiMessages`
- `/session compact` 会手动创建一个 `compact-session` helper agent，对较早历史生成结构化摘要
- 自动 compact 会在主 agent 真正发模型前触发；默认阈值为 `120000` tokens，默认保留最近 `8` 个完整 user turn 分组
- compact 后会把较早历史替换为一条带 `[QAGENT_COMPACT_SUMMARY v1]` 前缀的 synthetic user message，并保留最近原始上下文
- `compact-session` helper 不暴露任何工具，也不会递归触发 fetch-memory、save-memory 或 auto-compact

Session Graph 机制说明：

- `qagent` 默认恢复 active working head；如果 repo 不存在则初始化 `main`
- `qagent resume` 等价于 `qagent`
- `qagent resume <sessionId>` 会切换到对应的 working head session
- 遇到 v1 session repo 时会尽力原地迁移到 v2；如果历史数据损坏到无法恢复，才需要手动清理
- 一个 session repo 可以同时存在多个 working heads；每个 head 有独立 snapshot / events / shell / asset state
- branch 继续保持活的工作头语义，但同一条 branch 同时只允许一个 writer head
- `fork` 默认创建并切换到新的 branch-attached head；`/session head fork` 会创建 detached head
- `merge` 支持 digest + memory asset merge，不自动改写 Git/workspace reality
- `checkout` 和 `tag` 只恢复该 head 的会话态，不自动回退工作区
- `checkout <tag>` 后继续普通对话时，会自动从该 tag 长出一个新分支并拿到 writer lease

## 扩展点

- 新增 Tool：实现 Tool 模块并注册到 `ToolRegistry`
- 新增模型供应商：实现 `ModelClient`
- 自动 Skill 匹配：在 `SkillRegistry` 之上增加选择策略
- Memory 检索升级：替换 `MemoryService.search`
- 风险分级审批：替换 `ApprovalPolicy`

## 架构规范

- 跨模块调用必须通过各模块的 `index.ts` facade
- `src/runtime/appController.ts` 是组合根，负责装配具体实现
- `src/types.ts` 与 `src/utils/index.ts` 是共享层
- 源码文件之间禁止循环依赖

详细规范见 [ARCHITECTURE.md](/Users/qiuboyu/CodeLearning/QAgent/ARCHITECTURE.md)。

## 校验

```bash
npm run test:architecture
npm run check
```
