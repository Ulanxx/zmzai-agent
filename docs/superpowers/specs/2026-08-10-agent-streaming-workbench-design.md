# Agent 流式执行工作台设计

> 产品：`a.zmzai.cloud`。仓库：`zmzai-agent`。状态：已确认，待实现。

## 目标

把当前“活动文本列表 + 一段拼接回复”的任务界面，改为可理解、可审查、可恢复的 Agent 执行工作台。用户应能在一次任务中持续看到：Agent 当前在做什么、调用了什么工具、工具返回了什么、哪些 Workspace 对象被读取或修改，以及任务最后如何结束。

交互借鉴 `cloudflare-os` 的转录原则：工具调用是持久化的对话节点，运行过程和产物可回看。不得复用其 Cloudflare runtime、权限系统或源代码。

## 非目标

- 不引入多用户协作、聊天历史产品化、浏览器自动化或定时任务。
- 不改变现有 Workspace、Proposal、审批和 Relay 的安全边界。
- 不另建一条 WebSocket 或画布专用流；任务 SSE 是唯一实时事实源。

## 界面结构

采用“执行型对话”布局。

- 左侧：Workspace、文件树、版本记录。保持当前职责。
- 中央：单次任务的执行转录。顶部固定显示标题/模式、模型、运行时间、状态和停止操作；其下依次显示用户请求、工具节点、流式 Agent 回复和终态节点。
- 右侧：上下文画布。显示当前事件所涉及的文件预览、检索命中、Diff、提案或未来的 Sandbox 终端输出，而非重复中央转录。

Build 任务的 Diff 与 Proposal 是画布的一等对象。Plan 任务的文件读取和检索结果是画布的一等对象。

## 执行转录

每个工具调用使用稳定的 `toolCallId` 聚合，且有以下状态：`requested`、`running`、`completed`、`failed`。节点默认紧凑，显示工具名、用户可见的参数摘要、耗时和结果摘要；用户可展开安全截断的预览。

`message.delta` 仅更新当前 Agent 回复块，不能为每个 token 创建新节点。回复块在未完成时展示流式光标，收到 `message.completed` 或终态事件后固定为 Markdown 文本。

运行状态节点必须单独可见：`succeeded`、`waiting_approval`、`cancelled`、`failed`。其中 `waiting_approval` 是可见的中间状态，不关闭连接；失败节点应显示失败阶段和可操作的重试入口；取消须保留已经产生的转录。

## 画布投影

画布由同一事件序列派生，并维护两种焦点模式：

- `follow`：自动投影最新可视对象，例如正在读取的文件、最新检索命中、最新 Diff 或终端输出。
- `pinned`：用户主动选择文件、Diff 或工具节点后锁定该对象，后续事件不得抢走焦点；用户可恢复跟随。

对象类型包括：

- `file_preview`：路径、语言、截断正文、读取范围。
- `search_results`：查询、路径列表、命中摘要。
- `proposal_diff`：Proposal ID、文件变更、统一 Diff、审批状态。
- `execution_output`：未来 `exec` 工具的结构化标准输出/错误输出片段。

大对象按增量更新。画布使用 `artifact.upsert` 建立对象，用 `artifact.append` 按偏移追加正文；收到相同或较早 sequence 的事件必须忽略。

## SSE 契约扩展

所有事件先持久化，再以 sequence 顺序通过 `GET /api/runs/:runId/events` 推送。统一 envelope 为：

```text
{ id, runId, sequence, type, at, data }
```

SSE 使用 `id: <sequence>`、`event: <type>`、`data: <完整 envelope JSON>`。首次连接默认重放 sequence 大于 `0` 的全部历史事件；重连携带 `Last-Event-ID`，服务端只重放更大的 sequence。前端以 envelope 的 `sequence` 作为唯一去重和排序键，不能依赖到达顺序。浏览器只投影该事件流；刷新后先读任务快照，再以此规则接收 SSE 历史与实时事件。

现有事件保留，并扩展为：

```text
message.started      { messageId }
message.delta        { messageId, delta }
message.completed    { messageId }
tool.requested       { toolCallId, name, argsSummary, artifactRefs? }
tool.progress        { toolCallId, label? }
tool.completed       { toolCallId, name, durationMs, resultSummary: { text, truncated, omittedBytes }, artifactRefs? }
tool.failed          { toolCallId, name, durationMs, code, resultSummary }
artifact.upsert      { artifactId, kind, title, payload }
artifact.append      { artifactId, offset, text, truncated, omittedBytes }
proposal.created     { proposalId, summary, files, changeCount }
proposal.updated     { proposalId, summary, files, changeCount }
run.completed        { outcome }
run.failed           { code, error }
run.cancelled        { reason }
```

`argsSummary`、`resultSummary` 和 artifact payload 必须由 Tool Broker 生成，禁止直接透传模型原始参数或工具原始输出。它们必须执行密钥/认证头/Cookie 脱敏，并受单事件、单 artifact、单任务总字节预算限制。

默认限制为：单个摘要或 append 文本最多 4 KiB、单 artifact 在浏览器侧最多 32 KiB、单任务可见事件总量最多 64 KiB。工具摘要的截断元数据位于 `resultSummary.truncated` / `resultSummary.omittedBytes`；artifact 增量的截断元数据位于 `artifact.append.truncated` / `artifact.append.omittedBytes`。超出部分必须截断；工具和任务继续执行，原始内容只留在服务端受控日志。任务创建时必须为一个终态事件预留 1 KiB 的事件预算；若仍无法写入普通事件，运行进入 `failed`，失败码为 `EVENT_BUDGET_EXCEEDED`，并保证 `run.failed` 可持久化和推送，禁止静默丢弃或无限运行。

终态由任务状态和事件共同定义，映射固定如下：

```text
run.waiting_approval  -> TaskRun.status = waiting_approval，连接保持，等待审批 API
run.completed         -> TaskRun.status = succeeded，outcome 为 plan_completed | approved | rejected | conflict
run.failed            -> TaskRun.status = failed，data.code 必填
run.cancelled         -> TaskRun.status = cancelled，data.reason 必填
```

前端只在后三种终态事件到达时关闭 SSE；`run.waiting_approval` 不是终态。`GET /api/runs/:runId` 是状态恢复时的权威快照，事件用于补全可见转录和画布。

## 连接与恢复

前端维护最后已应用的 `sequence`。SSE 异常时以 `Last-Event-ID` 重连，并显示非阻塞的恢复状态；恢复期间定期读取任务快照。连接恢复后按 sequence 去重。任务达到终态才关闭连接。

页面重新打开时，前端先恢复历史事件，再连接实时流。历史和实时的合并规则相同，保证不会出现空白、重复工具节点或倒退的画布内容。

## 服务端边界

`agent-runtime` 和 Tool Broker 负责产生结构化、可公开展示的运行事件。前端不得推断工具是否成功，也不得从模型文本中解析工具状态。现有 Mongo 事件表继续作为重放来源；无需增加独立消息队列。

Sandbox `exec` 尚未接入 v1，但事件与画布对象的扩展点必须预留。Sandbox 输出不得包含宿主机、服务密钥或用户 `sandbox_key`。

## 验收与测试

- 文本 delta 在单个回复块内连续更新，最终固定为完整 Markdown。
- 一个工具调用只对应一个转录节点，覆盖开始、进度、完成和失败。
- `read`、`search`、`write`/`edit` 分别驱动文件、检索、Diff 画布。
- 用户固定画布焦点后，后续事件不覆盖该对象。
- 断线重连与刷新后按 sequence 无重复、无丢失地恢复。
- 取消、Relay 失败、工具失败、等待审批均有明确终态和界面动作。
- 所有可见事件均通过脱敏与预算测试；不得向浏览器发送密钥、Cookie 或完整敏感工具输出。

## 实施顺序

1. 抽取客户端事件投影 reducer 与转录/画布数据模型，并为现有事件补齐 UI。
2. 扩展 Tool Broker 事件为安全摘要和 artifact 引用，追加后端契约与测试。
3. 重构 Workbench 为转录节点、运行头、可固定画布与响应式布局。
4. 接入断线恢复、重放测试和端到端 SSE 验证。

## 契约扩展（2026-08-10 已实现）

- `run.resumed`：审批/拒绝后 Agent 恢复执行时发出，`data: { kind: "change" | "exec", note }`。`waiting_approval` 不是终态，SSE 保持连接，恢复事件与后续消息/工具事件经同一条流到达。
- `execution_output` artifact：`exec` 工具批准后在 Sandbox 运行，stdout/stderr 经 `artifact.upsert`（空内容）+ 逐行 `artifact.append` 流入画布；`payload.truncated` 表示达到 64 KiB 展示上限。exec 工具节点在批准前保持 `running`（label「等待审批」），批准后转「沙箱执行中」，完成后以真实 `resultSummary` 落 `tool.completed`/`tool.failed`。
- 执行提案（`kind: "exec"`）与变更提案（`kind: "change"`）共用 `waiting_approval` 状态与提案画布；`GET /api/runs/:runId/proposals` 返回两种提案，`kind` 区分。
