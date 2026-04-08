# QAgent 架构规范

本文档约束的是代码边界，而不是业务行为。目标是让 `QAgent` 在继续迭代时保持模块清晰、依赖稳定、容易测试。

## 模块边界

当前源码按顶层模块划分：

- `cli`
- `config`
- `context`
- `memory`
- `model`
- `runtime`
- `session`
- `skills`
- `tool`
- `ui`
- `utils`
- `types`

其中：

- `types` 是全局共享类型层
- `utils` 是全局共享工具层
- `runtime` 是编排层，也是组合根
- 其余目录都是职责明确的业务模块

## Facade 规则

每个顶层模块都必须暴露一个 `index.ts` 作为 facade。

允许：

- 模块内部文件互相直接引用
- 跨模块通过 `src/<module>/index.ts` 访问
- 任意模块直接访问 `src/types.ts`

禁止：

- 跨模块直接访问其他模块的内部文件
- 让 UI、Memory、Tool、Model 等模块互相穿透依赖
- 在新功能中绕过 facade 直接连到具体实现文件

## 组合根规则

`src/runtime/appController.ts` 是当前唯一组合根，负责装配：

- 配置加载
- 会话存储
- Skill 注册
- Memory 服务
- 模型客户端
- Tool 运行时

其他模块不应自行拼装跨模块实现，更不应偷偷 `new` 出另一个模块的底层服务后直接耦合。

## 依赖方向

允许的模块依赖如下：

- `cli -> runtime, ui, types`
- `config -> types, utils`
- `context -> types, utils`
- `memory -> types, utils`
- `model -> types, utils`
- `runtime -> config, context, memory, model, session, skills, tool, types, utils`
- `session -> types, utils`
- `skills -> types, utils`
- `tool -> types, utils`
- `ui -> runtime, types`
- `utils -> 无`
- `types -> 无`

如果未来要新增依赖方向，必须先修改架构测试和本文档，再改实现。

## 循环依赖

任何源码文件之间都不允许出现循环依赖。

原因：

- 循环依赖会让初始化顺序变得不可预测
- 会让 facade 和模块边界形同虚设
- 会增加测试、重构、替换实现时的复杂度

## Skill 模块特别约束

`skills` 模块只负责：

- 发现 Skill
- 解析 `SKILL.md`
- 暴露 Skill catalog

`skills` 模块不负责：

- 手动激活 Skill
- 持有 Skill 运行状态
- 直接执行 Skill 中的脚本或资源

具体 Skill 的使用由 Agent 通过唯一的 `shell` Tool 在运行时访问对应目录。

## Session 模块特别约束

`session` 模块分两层：

- `SessionStore` 负责工作态 `snapshot/events` 的存储
- `SessionGraphStore + SessionService` 负责 branch / fork / tag / checkout / merge 语义

额外约束：

- `runtime` 只能通过 `src/session/index.ts` facade 访问 session 能力
- `SessionService` 是 session 图语义的唯一入口
- `merge` 只合并 session 内部抽象资产，不合并 runtime reality
- `checkout` 只恢复会话态，不自动回退工作区

## 自动化校验

以下规则已经通过测试固化：

- 每个顶层模块必须有 facade `index.ts`
- 跨模块导入必须经过 facade
- 模块依赖必须符合白名单
- 源码文件之间不能出现循环依赖

执行方式：

```bash
npm run test:architecture
```

完整项目校验：

```bash
npm run check
```
# QAgent — Architecture Overview

> **Version**: 0.1.0 · **Runtime**: Node.js + TypeScript · **UI**: Ink (React for Terminal)

---

## 1. High-Level System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                            QAgent  System  Overview                              │
│                                                                                  │
│  ┌─────────────┐    parseCliArgs()     ┌─────────────────────────────────────┐   │
│  │  bin/       │ ──────────────────>   │  src/cli/                           │   │
│  │  qagent.js  │                       │  index.ts                           │   │
│  └─────────────┘                       │  · runCli()                         │   │
│                                        │  · parseCliArgs()                   │   │
│                                        └──────────────┬──────────────────────┘   │
│                                                       │                          │
│                                     createAppController(cliOptions)              │
│                                                       │                          │
│                          ┌────────────────────────────▼──────────────────────┐   │
│                          │          src/runtime/                             │   │
│                          │          AppController                            │   │
│                          │  ┌─────────────────────────────────────────────┐  │   │
│                          │  │  · loadRuntimeConfig()        [config]      │  │   │
│                          │  │  · createModelClient()        [model]       │  │   │
│                          │  │  · SkillRegistry              [skills]      │  │   │
│                          │  │  · ApprovalPolicy             [tool]        │  │   │
│                          │  │  · PromptAssembler            [context]     │  │   │
│                          │  │  · SessionService             [session]     │  │   │
│                          │  │  · AgentManager               [runtime]     │  │   │
│                          │  │  · SlashCommandBus            [runtime]     │  │   │
│                          │  │  · AppStateAssembler          [runtime]     │  │   │
│                          │  └─────────────────────────────────────────────┘  │   │
│                          └───────┬────────────────────────────┬──────────────┘   │
│                                  │ subscribe(state => ...)    │ submitInput()    │
│                   ┌──────────────▼───────────┐                │                  │
│                   │     src/ui/              │     ┌──────────▼────────────┐     │
│                   │     Ink / React TUI      │     │  AgentManager         │     │
│                   │                          │     │  (多Agent调度核心)     │     │
│                   │  ┌────────────────────┐  │     └──────────┬────────────┘     │
│                   │  │ App.tsx            │  │                │                  │
│                   │  │ MessageList.tsx    │  │     ┌──────────▼────────────┐     │
│                   │  │ InputBox.tsx       │  │     │  HeadAgentRuntime     │     │
│                   │  │ StatusBar.tsx      │  │     │  (单Agent执行上下文)   │     │
│                   │  │ AgentList.tsx      │  │     └──────────┬────────────┘     │
│                   │  │ ApprovalModal.tsx  │  │                │                  │
│                   │  │ inputEnhancements  │  │     ┌──────────▼────────────┐     │
│                   │  │ presentation/      │  │     │  AgentRunner          │     │
│                   │  │  └─ footerHint.ts  │  │     │  (LLM Turn Loop)      │     │
│                   │  └────────────────────┘  │     └───────────────────────┘     │
│                   └──────────────────────────┘                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Module Dependency Graph

```
                          ┌───────────────────┐
                          │    src/cli/        │
                          │    (Entry Point)   │
                          └────────┬──────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │      src/runtime/            │
                    │      (Orchestration Core)    │
                    └──┬───┬───┬───┬───┬───┬──────┘
                       │   │   │   │   │   │
          ┌────────────┘   │   │   │   │   └────────────┐
          │                │   │   │   │                 │
          ▼                ▼   │   ▼   │                 ▼
   ┌────────────┐ ┌──────────┐│┌──────────┐    ┌──────────────┐
   │ src/config/ │ │src/model/│││src/tool/ │    │  src/ui/      │
   │             │ │          │││          │    │  (React TUI)  │
   │ loadConfig  │ │ OpenAI   │││ Shell    │    │               │
   │ configPersi │ │ Compat   │││ Approval │    │  App.tsx      │
   │ stence      │ │ Client   │││ Registry │    │  Message/     │
   └────────────┘ └──────────┘│└──────────┘    │  Input/       │
                              │                 │  Status       │
                   ┌──────────▼──┐              └──────────────┘
                   │ src/context/ │
                   │              │
                   │ promptAsm    │
                   │ agentDocs    │
                   └──────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
       ┌────────────┐   ┌────────────┐  ┌────────────┐
       │ src/memory/ │  │ src/skills/│  │ src/session/│
       │             │  │            │  │             │
       │ memoryServ  │  │ skillReg   │  │ sessionServ │
       │ sessionAss  │  │ istryts    │  │ sessionStor │
       │ etProvider  │  └────────────┘  │ sessionDom  │
       └────────────┘                   │ sessionGraph│
              │                         │ digestAsset │
              │                         │ assetOverlay│
              │                         │ migration   │
              │                         └─────────────┘
              │
              ▼
       ┌────────────┐
       │ src/utils/  │
       │ src/types.ts│
       │             │
       │ fs / ids /  │
       │ text        │
       └────────────┘
```

---

## 3. Runtime Module Detail (src/runtime/)

```
src/runtime/
│
├── appController.ts            ← 应用总控制器，唯一对外暴露口
│   ├─ create(cliOptions)         初始化一切，返回 AppController
│   ├─ submitInput(input)         用户输入分发 → SlashBus / AgentManager
│   ├─ subscribe(listener)        状态变更订阅 (观察者模式)
│   └─ requestExit / dispose      生命周期管理
│
├── agentManager.ts             ← 多Agent调度器
│   ├─ initialize()               创建/恢复 Session 与主 Agent
│   ├─ submitInputToActiveAgent()  将输入路由到活跃 Agent
│   ├─ spawnTaskAgent()           派生 task 子Agent
│   ├─ spawnInteractiveAgent()    派生 interactive 子Agent
│   ├─ switchAgent()              切换活跃 Agent
│   └─ closeAgent()              关闭 Agent
│
├── agentRuntime.ts             ← HeadAgentRuntime (单Agent执行上下文)
│   ├─ submitInput(input)         记录会话 → 启动 runLoop
│   ├─ runLoop()                  调用 AgentRunner
│   ├─ commitAssistantTurn()      写入 assistant 消息
│   ├─ commitToolResult()         写入 tool 结果
│   ├─ requestApproval()          等待用户审批
│   ├─ applyCompaction()          压缩会话上下文
│   └─ dispose()                  释放 ShellSession 等资源
│
├── agentRunner.ts              ← LLM Turn Loop 执行器
│   ├─ runLoop()
│   │   while(hasToolCalls && steps < max):
│   │       1. assemblePrompt()   ← PromptAssembler
│   │       2. modelClient.runTurn()
│   │       3. commitAssistantTurn()
│   │       4. for each toolCall:
│   │          a. approvalPolicy.check()
│   │          b. requestApproval() [if needed]
│   │          c. shellTool.execute()
│   │          d. commitToolResult()
│   └─ interrupt()
│
├── agentRuntimeFactory.ts      ← 工厂：创建 HeadAgentRuntime 实例
│
├── slashCommandBus.ts          ← 斜杠命令分发器
│   ├─ /exit /clear /status
│   ├─ /model /provider /apikey
│   ├─ /memory /save /show
│   ├─ /compact /branch /checkout /tag /merge
│   ├─ /agent /spawn /switch /close
│   └─ /head /hook /debug ...
│
├── appState.ts                 ← 不可变应用状态 (AppState) + 事件 reduce
│
├── autoMemoryForkService.ts    ← RunLoop完成后自动保存记忆
├── compactSessionService.ts    ← 上下文压缩(摘要Agent)
├── fetchMemoryService.ts       ← RunLoop前自动检索相关记忆
│
├── application/
│   ├─ agentLifecycleService.ts  Agent 生命周期 (创建/销毁)
│   ├─ agentNavigationService.ts Agent 导航切换
│   ├─ agentRegistry.ts          Agent 注册表
│   ├─ appStateAssembler.ts      聚合各子系统 → AppState
│   ├─ helperAgentCoordinator.ts Helper Agent 协调器
│   └─ hookPipeline.ts           钩子管线(fetch-memory/save-memory/compact)
│
└── domain/
    └─ contextBudgetService.ts   Token 预算估算 & 消息分组
```

---

## 4. Session Module Detail (src/session/)

```
src/session/
│
├── sessionService.ts           ← 会话核心服务 (41KB，最大文件)
│   ├─ createSession()            创建新会话
│   ├─ resumeSession()            恢复已存在的会话
│   ├─ getHead / updateHead       WorkingHead CRUD
│   ├─ forkHead / mergeHead       分叉 / 合并 WorkingHead
│   ├─ checkpoint / restore       快照检查点
│   ├─ branch / tag / checkout    Git-like 引用管理
│   └─ flushCompactSnapshot()     压缩后写入磁盘
│
├── sessionStore.ts             ← 磁盘持久化 (JSON文件)
│   ├─ readRepoState / writeRepoState
│   ├─ readNode / writeNode
│   ├─ readBranch / writeBranch
│   └─ readHead / writeHead
│
├── sessionGraphStore.ts        ← DAG 图谱 (节点、边)
│   ├─ addNode / getNode
│   ├─ getAncestorChain()
│   └─ toDebugGraph()
│
├── digestAssetProvider.ts      ← 会话摘要资产
│
├── application/
│   ├─ assetOverlayService.ts     资产覆盖层
│   └─ sessionRepoMigrationService.ts  版本迁移
│
└── domain/
    ├─ sessionDomain.ts           核心领域逻辑
    └─ sessionEvents.ts           事件工厂函数
```

### Session DAG Model (Git-like)

```
                          ┌──────────┐
                          │  Repo    │
                          │  State   │
                          │ (v2)     │
                          └─────┬────┘
                                │ activeWorkingHeadId
                                ▼
                    ┌─────────────────────────┐
                    │    WorkingHead          │
                    │    ┌─────────────────┐  │
                    │    │ attachment:     │  │
                    │    │  branch "main" │  │
                    │    │ runtimeState   │  │
                    │    │ assetState     │  │
                    │    └─────────────────┘  │
                    └───────────┬─────────────┘
                                │ currentNodeId
                                ▼
        ┌──────────────────────────────────────────────┐
        │               Session Node DAG               │
        │                                              │
        │   [root] ── [checkpoint] ── [checkpoint]     │
        │                  │                           │
        │                  ├── [compact]               │
        │                  │      │                    │
        │                  │      └── [checkpoint]     │
        │                  │                           │
        │                  └── [branch B]              │
        │                        │                     │
        │                        └── [merge] ◄─────┐   │
        │                                          │   │
        │                             [branch C] ──┘   │
        └──────────────────────────────────────────────┘

每个 Node 包含：
  · SessionSnapshot   (会话快照：entries, uiMessages, modelMessages)
  · AbstractAssets    (摘要资产)
  · snapshotHash      (完整性)
```

---

## 5. Memory Module (src/memory/)

```
src/memory/
│
├── memoryService.ts            ← 记忆读写服务
│   ├─ list(limit?)               列出记忆
│   ├─ search(query, topK)        关键词搜索
│   ├─ save({name, desc, ...})    创建/更新记忆
│   └─ show(name)                 查看单条
│
├── sessionAssetProvider.ts     ← SessionAssetProvider 实现
│   ├─ fork()                     Head 分叉时拷贝 memory dir
│   ├─ checkpoint()               检查点时同步
│   ├─ restore()                  恢复时还原
│   └─ merge()                    合并冲突处理
│
└── 存储格式：
    project/.agent/memory/*.json
    global/.agent/memory/*.json

    单条记忆 (MemoryRecord):
    {
      id, name, description,
      content, keywords[],
      scope: "project" | "global",
      createdAt, updatedAt, lastAccessedAt,
      directoryPath, path
    }
```

---

## 6. Other Modules

### Config (src/config/)

```
src/config/
├── loadConfig.ts               ← 配置加载链
│   ├─ resolveResolvedPaths()     解析路径
│   ├─ loadRuntimeConfig()        合并 CLI → Env → Project → Global
│   ├─ defaultBaseUrlForProvider() OpenAI / OpenRouter URL
│   └─ 环境变量: QAGENT_API_KEY, QAGENT_MODEL, QAGENT_PROVIDER ...
│
├── configPersistence.ts        ← 配置持久化
│   ├─ persistProjectModelConfig()
│   └─ persistGlobalModelConfig()
│
└── 配置优先级:
      CLI args  >  Environment  >  .agent/config.json (project)  >  .agent/config.json (global)
```

### Model (src/model/)

```
src/model/
├── createModelClient.ts        ← 工厂
│   └─ createModelClient(cfg) → ModelClient
│
└── openaiCompatibleModelClient.ts  ← OpenAI 兼容客户端
    ├─ runTurn(request, hooks?, signal?)
    │   · 构建 OpenAI ChatCompletion 请求
    │   · 支持流式输出 (Stream Hooks)
    │   · 支持 AbortSignal 中断
    └─ provider: "openai" | "openrouter"
```

### Tool (src/tool/)

```
src/tool/
├── shellTool.ts                ← Shell 命令工具
│   ├─ execute(command)           在持久化 Shell 中执行
│   └─ getRuntimeStatus()         当前 cwd、环境状态
│
├── shellSession.ts             ← 持久化 Shell 进程
│   ├─ PersistentShellSession
│   │   · 保持单个子进程存活
│   │   · 逐命令序列化执行
│   │   · 超时控制
│   └─ formatToolResultForModel()
│
├── approvalPolicy.ts           ← 审批策略
│   └─ mode: "always" | "risky" | "never"
│
└── toolRegistry.ts             ← 工具注册表
    └─ getDefinitions() → ToolDefinition[]
```

### Context (src/context/)

```
src/context/
├── promptAssembler.ts          ← System Prompt 组装器
│   ├─ assemble(layers, config)
│   │   · 按 priority 排序 InstructionLayer
│   │   · 拼接 base / global / project / skill / memory / digest
│   └─ 支持 PromptProfile: default / auto-memory / fetch-memory / compact-session
│
└── agentDocuments.ts           ← Agent 文档加载
    └─ loadAgentDocuments(path) → InstructionLayer[]
```

### Skills (src/skills/)

```
src/skills/
├── skillRegistry.ts            ← 技能注册表
│   ├─ refresh()                  扫描 global + project 目录
│   └─ getAll() → SkillManifest[]
│
└── 技能存储：
    project/.agent/skills/**.md   (项目级)
    global/.agent/skills/**.md    (全局级)
```

### Utils & Types

```
src/utils/
├── fs.ts                       ← 文件系统工具
├── ids.ts                      ← ID 生成器 (createId)
└── text.ts                     ← 文本处理 (firstLine, formatDuration ...)

src/types.ts                    ← 全局类型定义 (586 行)
  · RuntimeConfig, CliOptions
  · SessionSnapshot, SessionNode, SessionWorkingHead
  · ConversationEntry, LlmMessage, UIMessage
  · ToolCall, ToolResult, ApprovalRequest
  · ModelClient, ModelTurnRequest/Result
  · SessionAssetProvider (fork/checkpoint/restore/merge)
  · SlashCommandResult
```

---

## 7. Data Flow — User Input to LLM Response

```
┌──────────┐   text   ┌───────────┐  slash?  ┌──────────────────┐
│  User    │ ───────> │ AppCtrl   │ ──YES──> │  SlashCommandBus │ ─> 直接处理
│ (stdin)  │          │ .submit() │          └──────────────────┘
└──────────┘          └─────┬─────┘
                            │ NO (普通输入)
                            ▼
                   ┌─────────────────┐
                   │  AgentManager   │
                   │  .submitInput   │
                   │  ToActiveAgent()│
                   └────────┬────────┘
                            │ 路由到活跃 HeadAgentRuntime
                            ▼
                   ┌─────────────────────┐
                   │  HeadAgentRuntime   │
                   │  .submitInput()     │
                   │  1. 记录 entry      │
                   │  2. runLoop()       │
                   └────────┬────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │       AgentRunner           │
              │       .runLoop()            │
              │                             │
              │  ┌────────────────────┐     │
              │  │ STEP 1: Assemble  │     │
              │  │ System Prompt     │     │
              │  │ (PromptAssembler) │     │
              │  └────────┬───────────┘     │
              │           ▼                 │
              │  ┌────────────────────┐     │
              │  │ STEP 2: Call LLM  │     │
              │  │ modelClient       │     │
              │  │ .runTurn()        │     │
              │  │ (Stream Hooks)    │     │
              │  └────────┬───────────┘     │
              │           ▼                 │
              │  ┌────────────────────┐     │
              │  │ STEP 3: Process   │     │
              │  │ Tool Calls        │     │
              │  │ ┌───────────────┐ │     │
              │  │ │ApprovalPolicy │ │     │
              │  │ │ .check()     │ │     │
              │  │ └───────┬───────┘ │     │
              │  │         ▼         │     │
              │  │ ┌───────────────┐ │     │
              │  │ │ ShellTool     │ │     │
              │  │ │ .execute()   │ │     │
              │  │ └───────────────┘ │     │
              │  └────────────────────┘     │
              │           │                 │
              │      Loop if toolCalls      │
              └─────────────────────────────┘
                            │
                            ▼
              ┌───────────────────────────────────┐
              │  Post-Run Hooks (HookPipeline)    │
              │                                   │
              │  ┌───────────────────────┐        │
              │  │ AutoMemoryForkService │        │
              │  │ (save-memory Agent)   │        │
              │  └───────────────────────┘        │
              │  ┌───────────────────────┐        │
              │  │ FetchMemoryService    │        │
              │  │ (before next turn)    │        │
              │  └───────────────────────┘        │
              │  ┌───────────────────────┐        │
              │  │ CompactSessionService │        │
              │  │ (auto-compact when    │        │
              │  │  tokens > threshold)  │        │
              │  └───────────────────────┘        │
              └───────────────────────────────────┘
                            │
                            ▼
              ┌───────────────────────────────────┐
              │  SessionService                   │
              │  · checkpoint()                   │
              │  · writeNode() → sessionStore     │
              │  · updateHead()                   │
              └───────────────────────────────────┘
                            │
                            ▼
              ┌───────────────────────────────────┐
              │  UI State Update                  │
              │  AppStateAssembler → AppState     │
              │  events.emit("state", state)      │
              │  ──────────────────────────>       │
              │  Ink / React re-render            │
              └───────────────────────────────────┘
```

---

## 8. Directory Tree

```
QAgent/
├── bin/
│   └── qagent.js                    # Node.js 入口脚本
├── src/
│   ├── cli/
│   │   └── index.ts                 # CLI 参数解析 & 启动
│   ├── config/
│   │   ├── index.ts
│   │   ├── loadConfig.ts            # 配置加载链
│   │   └── configPersistence.ts     # 配置持久化
│   ├── context/
│   │   ├── index.ts
│   │   ├── promptAssembler.ts       # System Prompt 组装
│   │   └── agentDocuments.ts        # Agent 指令文档
│   ├── memory/
│   │   ├── index.ts
│   │   ├── memoryService.ts         # 记忆 CRUD + 搜索
│   │   └── sessionAssetProvider.ts  # 记忆的 fork/merge 支持
│   ├── model/
│   │   ├── index.ts
│   │   ├── createModelClient.ts     # 工厂
│   │   └── openaiCompatibleModelClient.ts  # OpenAI 兼容
│   ├── runtime/
│   │   ├── index.ts
│   │   ├── appController.ts         # 应用总控
│   │   ├── agentManager.ts          # 多Agent管理
│   │   ├── agentRuntime.ts          # 单Agent执行上下文
│   │   ├── agentRunner.ts           # LLM Turn Loop
│   │   ├── agentRuntimeFactory.ts   # Runtime 工厂
│   │   ├── appState.ts              # 不可变状态 + reduce
│   │   ├── slashCommandBus.ts       # 斜杠命令
│   │   ├── autoMemoryForkService.ts # 自动保存记忆
│   │   ├── compactSessionService.ts # 上下文压缩
│   │   ├── fetchMemoryService.ts    # 记忆检索
│   │   ├── application/
│   │   │   ├── agentLifecycleService.ts
│   │   │   ├── agentNavigationService.ts
│   │   │   ├── agentRegistry.ts
│   │   │   ├── appStateAssembler.ts
│   │   │   ├── helperAgentCoordinator.ts
│   │   │   └── hookPipeline.ts
│   │   └── domain/
│   │       └── contextBudgetService.ts
│   ├── session/
│   │   ├── index.ts
│   │   ├── sessionService.ts        # 会话核心
│   │   ├── sessionStore.ts          # 磁盘持久化
│   │   ├── sessionGraphStore.ts     # DAG 图谱
│   │   ├── digestAssetProvider.ts   # 摘要资产
│   │   ├── application/
│   │   │   ├── assetOverlayService.ts
│   │   │   └── sessionRepoMigrationService.ts
│   │   └── domain/
│   │       ├── sessionDomain.ts
│   │       └── sessionEvents.ts
│   ├── skills/
│   │   ├── index.ts
│   │   └── skillRegistry.ts         # 技能注册
│   ├── tool/
│   │   ├── index.ts
│   │   ├── shellTool.ts             # Shell 命令执行
│   │   ├── shellSession.ts          # 持久化 Shell
│   │   ├── approvalPolicy.ts        # 审批策略
│   │   └── toolRegistry.ts          # 工具注册
│   ├── ui/
│   │   ├── index.ts
│   │   ├── App.tsx                  # 主应用组件
│   │   ├── MessageList.tsx          # 消息列表
│   │   ├── InputBox.tsx             # 输入框
│   │   ├── StatusBar.tsx            # 状态栏
│   │   ├── AgentList.tsx            # Agent 列表
│   │   ├── ApprovalModal.tsx        # 审批弹窗
│   │   ├── inputEnhancements.ts     # 输入增强
│   │   └── presentation/
│   │       └── footerHint.ts
│   ├── utils/
│   │   ├── index.ts
│   │   ├── fs.ts                    # 文件工具
│   │   ├── ids.ts                   # ID生成
│   │   └── text.ts                  # 文本工具
│   └── types.ts                     # 全局类型 (586行)
├── test/
│   ├── architecture/                # 架构守卫测试
│   ├── unit/                        # 单元测试
│   ├── integration/                 # 集成测试
│   ├── ui/                          # UI 测试
│   ├── fixtures/                    # 测试数据
│   └── helpers/                     # 测试工具
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── eslint.config.js
```

---

## 9. Key Design Patterns

| Pattern | Where | Purpose |
|---------|-------|---------|
| **Event Sourcing** | `SessionService` / `sessionEvents.ts` | 所有会话变更以事件形式记录，可回放重建状态 |
| **CQRS (读写分离)** | `ConversationEntry` → `uiMessages` / `modelMessages` | 同一数据源投影出 UI 视图和模型上下文 |
| **Git-like DAG** | `SessionNode` / `SessionGraphStore` | 支持 branch / tag / merge / checkout |
| **Observer** | `AppController.subscribe()` | UI 订阅状态变更，React 驱动重渲染 |
| **Strategy** | `ApprovalPolicy` / `PromptProfile` | 可切换的审批策略和提示词组装策略 |
| **Factory** | `AgentRuntimeFactory` / `createModelClient` | 解耦创建逻辑 |
| **Hook Pipeline** | `hookPipeline.ts` | 可插拔的 pre/post 钩子 (fetch-memory, save-memory, auto-compact) |
| **Helper Agent** | `helperAgentCoordinator.ts` | 主Agent派生短生命周期子Agent执行特定任务 |

---

*Generated on 2026-04-08 · QAgent v0.1.0*
