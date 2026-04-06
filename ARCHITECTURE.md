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
