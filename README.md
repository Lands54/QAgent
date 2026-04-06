# QAgent

一个基于 `TypeScript + React + Ink` 的终端 Agent CLI。

## 特性

- 单一 Tool 设计：模型侧只暴露 `shell`
- `Skill` 系统：启动时汇总全部 Skill 的 `name/description` 元信息，使用时通过 shell 直接访问 Skill 目录
- `Memory` 系统：文件持久化，手动保存，检索注入
- `AGENT.md / AGENTS.md` 注入：支持全局与项目级规则
- 斜杠命令：不经过模型，直接操作控制面
- 持久 shell 会话：支持 `cd` 和上下文延续
- Git 风格的 Session Graph：支持 branch / fork / tag / checkout / merge

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
- `QAGENT_SHELL_TIMEOUT_MS`

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
- `/memory save [--global] [--tags=a,b] [--title=标题] <内容>`
- `/memory list`
- `/memory show <id>`
- `/skills list`
- `/skills show <name|id>`
- `/session status`
- `/session list`
- `/session log [--limit=N]`
- `/session branch <name>`
- `/session fork <name>`
- `/session checkout <ref>`
- `/session tag <name>`
- `/session merge <sourceRef>`
- `/agent status`
- `/agent interrupt`
- `/agent resume`
- `/clear`
- `/exit`

模型配置说明：

- `/model provider` 与 `/model name` 会写入项目级 `.agent/config.json`
- `/model apikey` 会写入全局 `~/.agent/config.json`，避免把密钥直接写进项目配置

Skill 机制说明：

- 每个 Skill 是一个目录，至少包含一个 `SKILL.md`
- 每个 `SKILL.md` 包含 YAML frontmatter + Markdown 正文
- 当前实现会在每轮上下文构建时收集所有 Skill 的 `name/description`，合成为一段统一的 YAML 元信息索引注入上下文
- 不会自动把所有 Skill 的正文注入上下文
- Agent 需要使用某个 Skill 时，应通过 `shell` 直接读取对应 Skill 目录中的 `SKILL.md`、`scripts/`、`references/`、`assets/` 等内容

Session Graph 机制说明：

- `qagent` 默认恢复当前 checkout；如果 repo 不存在则初始化 `main`
- `qagent resume` 等价于 `qagent`
- `qagent resume <sessionId>` 会导入指定 legacy session，并进入 detached 状态
- `branch/fork/tag/checkout` 操作的是具体会话状态
- `merge` 只合并 session 内部抽象资产，不自动改写工作区现实，也不直接写入 `memory`
- `checkout` 和 `tag` 只恢复会话态，不自动回退 Git/workspace reality
- `checkout <tag>` 后继续普通对话时，会自动从该 tag 长出一个新分支

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
