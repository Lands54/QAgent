# QAgent 概念模型

## 核心词汇

- 工位（`workline`）
  用户工作的主对象。一个工位绑定一个 session head，并承载当前执行上下文、书签附着关系、会话图位置与可见状态。
- 执行器（`executor`）
  工位上的执行单元。一个工位通常对应一个主执行器，也可以附带 helper / task 执行器。
- 书签（`bookmark`）
  面向用户的统一概念，用来包装 `branch` / `tag`。用户只需要理解“书签”，内部仍保留可写分支与只读标签的差异。
- 会话图（`session graph`）
  用来表示节点、提交、分叉、合并与 head/书签关系的历史图。

## 概念关系

```mermaid
flowchart LR
  workline["工位 / workline"] --> executor["执行器 / executor"]
  workline --> bookmark["书签 / bookmark"]
  workline --> head["session head"]
  head --> graph["会话图 / session graph"]
  bookmark --> graph
  executor --> graph
```

## 对外命名

- 英文命令域以 `workline / executor / bookmark / session` 为主。
- 中文界面以 `工位 / 执行器 / 书签 / 会话图` 为主。
- 旧的 `/work` 仅保留为兼容别名，帮助文案和主路径不再展示。

## 命令映射

- `/workline status|list|new|switch|next|prev|close|detach|merge`
- `/executor status|list|interrupt|resume`
- `/bookmark status|list|save|tag|switch|merge`
- `/session commit|compact|reset-context|log|graph log`

## 内外分层

- 对外词汇优先稳定：工位、执行器、书签、会话图。
- 内部实现仍可保留 `head / ref / branch / tag / checkpoint` 等技术术语。
- 解析层负责兼容旧命令别名，handler / service 内部统一使用主词汇，不让旧词继续穿透。
