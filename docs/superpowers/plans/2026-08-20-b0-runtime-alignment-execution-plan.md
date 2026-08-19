# B0 Runtime 对齐与契约冻结执行计划

> 上位路线图：[Chat-first 通用智能体平台全局路线图](./2026-08-20-chat-first-general-agent-platform-roadmap.md)
>
> 目标：在不重建现有 Runtime 的前提下，把当前 `Session` Runtime 对齐到产品的 `Workspace → Project → Task → Run` 语义，并冻结跨仓库契约。

## 1. B0 结论

当前 `zmzai-agent` 已完成一次从旧 Plan/Build/TaskRun 工作台到 PI Runtime 的迁移：

- 运行时主对象是 `Session`，持久化为 `ZmzaiFrameworkSession`。
- 消息和工具活动分别落在 `FrameworkMessage`、`FrameworkPart`，事件落在 `FrameworkEvent`。
- `SessionRunner` 已提供 FIFO prompt、权限等待、子代理、Sandbox 执行、SSE replay 和 Lease Recovery。
- 旧的 `TaskRun`、`ToolCall`、`ArtifactReference` 产品投影已从当前代码删除，旧 Mongo collection 仍可能保留。

因此 B0 的架构决策是：

1. `Session` 不直接对外冒充新规范的 `Task`，而是作为当前 Runtime 的兼容执行容器。
2. 新增产品控制面投影：`Task` 表达持续目标，`Run` 表达一次执行尝试；一个 Task 最多一个 active Run。
3. `Session` 与 `Run` 在迁移期保持一对一关联；子代理 Session 只投影为 `Subagent`，不能被用户任务列表误显示为独立 Task。
4. 现有 framework event 继续作为底层事件流，但必须增加产品事件 envelope 和状态投影，前端不再从 `session.status=idle` 推断成功或失败。
5. 旧 collection 只读保留用于审计/回退，不再作为新 API 的写入事实来源。

## 2. 现状到规范映射

| 规范对象 | 当前实现 | B0 处理 | 事实来源 |
| --- | --- | --- | --- |
| Workspace | `WorkspaceModel`，包含 Agent 配置、文件、权限策略 | 保留现有身份；后续补 Project 层，不把 Workspace 直接改名为 Project | `zmzai-agent` Mongo |
| Project | 尚无统一产品模型 | 先预留 `projectId` 和访问边界；P1 完成正式模型 | `zmzai-db` schema，P1 发布 |
| Task | 当前没有独立产品实体；创建 API 是 `POST /api/fw/sessions` | 新增 Task 控制面，保存目标、项目、当前状态和 active Run 引用 | `zmzai-agent` |
| Run | 当前 `SessionRunner` 的一次 prompt/run loop；Sandbox 另有 `SandboxRun` | 新增 Run 投影，关联 `sessionId`、`parentRunId`、checkpoint 和状态 | `zmzai-agent` |
| Subagent | 子代理是带 `parentId` 的 framework Session，父消息有 `subtask` Part | 保留 Session 作为执行上下文，增加 Subagent 投影/汇总 | `zmzai-agent` |
| ToolCall | framework `Part.type=tool`，状态有 pending/running/completed/error | 由 Part/event 投影成可审计 ToolCall；不再让 UI 解析消息文本 | `zmzai-agent` |
| Approval | `PermissionEngine` + `permission.asked/replied`，规则持久化在 Session | B0 建立 request/grant 兼容字段；现有 once/always/reject 先明确映射 | `zmzai-agent` |
| Event | 每 Session 单调递增 `FrameworkEvent.seq` | 保留底层 seq；新增 `taskId/runId` envelope 和 replay 约束 | `zmzai-agent` |
| Artifact | framework `artifact.created` + `SandboxArtifactModel` | P0 统一 Artifact 元数据；B0 只冻结来源和权限边界 | `zmzai-agent` |
| SandboxRun | `zmzai-sandbox` 有独立持久化 run，支持 `taskRunId/requestId` 幂等 | `taskRunId` 过渡映射到规范 `runId`；不让 Sandbox 定义 Task 状态 | `zmzai-sandbox` |

### 2.1 兼容 ID 规则

迁移期使用显式关联，不依赖 ID 字符串猜测：

```text
Task.taskId       = task_...
Run.runId         = run_...
Run.sessionId     = ses_...
Subagent.sessionId = ses_... (parentId 指向父 Session)
SandboxRun.id     = run_... (Sandbox 服务当前命名空间)
```

必须保存 `Run.sessionId` 和 `SandboxRun.id`，并通过字段/服务命名空间区分两者，不得把 Sandbox `run.id` 当成产品 Run ID。现有 Sandbox API 中的 `taskRunId` 在 B0 期间改名为 `runId` 需要兼容读取，正式切换前保留版本化适配器。

## 3. 状态差异与投影规则

当前 Runtime 只有：

```text
idle | running | waiting_permission
```

这不是产品 Run 状态。B0 采用如下投影：

| Framework 状态/事件 | 产品 Run 状态 | 说明 |
| --- | --- | --- |
| 创建 Session，未提交 prompt | `created` | Task 可为 `draft` |
| 首次 prompt accepted | `created → running` | 必须写 Run 创建事件 |
| `session.status=running` | `running` | 仅表示当前执行中 |
| `permission.asked` | `waiting_approval` | B0 先覆盖现有 PermissionEngine；`waiting_input` 另行定义 |
| `permission.replied=once/always` | `running` | 产生 ApprovalDecision；`always` 不等同永久 Grant |
| `permission.replied=reject` | `failed` 或安全替代路径继续 | 必须由 runner 明确结果，不能由 UI 推断 |
| `session.error` | `failed` | 保存 error code、最近 checkpoint 和已完成成果 |
| `session.status=idle` 且无 error | `succeeded`（仅在交付条件满足时） | 不能把 idle 单独当成功；B0 先记录 terminal reason |
| abort/lease recovery | `cancelled` 或 `failed` | 由控制面根据取消来源和恢复结果决定 |

P0 才实现完整的 `paused / waiting_input / continuation Run`。B0 的最低要求是：非法状态转换被拒绝，服务重启后不会把一个未判定的 `idle` 伪装成成功。

## 4. 跨仓库契约边界

### 4.1 `zmzai-agent`

负责 Task/Run 的控制面、状态机、事件 envelope、审批业务判定、恢复和产品 API。现有 framework package 只提供执行引擎，不拥有 Project/Task 业务状态。

### 4.2 `zmzai-sandbox`

负责隔离执行、资源限制、执行事件、取消、Lease Recovery 和产物 manifest。它接收已授权快照和命令，不负责判断 Project 角色、Task Approval 或产品 Run 终态。

当前已具备：

- `taskRunId + requestId` 请求幂等冲突检测。
- Mongo 持久化 SandboxRun。
- 执行 Lease、容量槽和过期回收。
- Agent 内部查询、事件流、取消和 Artifact 读取 API。

B0 必须补齐：

- 请求字段版本和 `runId` 兼容别名。
- `unknown` 执行结果，不把进程失联简单等同于业务失败。
- 产物 manifest 的稳定版本和哈希语义。

### 4.3 `zmzai-relay`

负责模型目录、流式 Chat、额度/成本和 Relay 错误。`zmzai-agent` 只通过内部服务契约调用，不把 Relay provider key 或原始上游错误暴露给浏览器。

B0 必须冻结：`requestId`、`taskId/runId` 关联字段、取消语义、可重试错误、额度不足错误和流中断错误。

### 4.4 `zmzai-db` / `zmzai-auth`

- `zmzai-db` 发布共享类型、schema 和索引，不执行 Runtime 状态机。
- `zmzai-auth` 只提供身份和登录会话；Project/Task 业务权限由 `zmzai-agent` 判定。

当前 `zmzai-db` 只有用户、会话和账户模型，不能在 B0 假设它已经提供 Project/Task schema；新 schema 发布前，Agent 端不得复制一套“共享类型”的伪实现。

## 5. 第一批代码任务

### B0-A：建立产品控制面骨架

目标文件：`zmzai-agent/models/`、`zmzai-agent/framework/core/`、`zmzai-agent/app/api/`

- 新增 Task、Run、Checkpoint、ApprovalRequest/Grant 的最小 schema 和 TypeScript 类型。
- 建立状态转换函数，所有状态写入必须经过转换函数。
- 建立 `Task → activeRunId` 唯一约束，拒绝第二个 active Run。
- 创建 Task 时可以关联现有 Workspace；Project 先允许为空并显式标记为迁移字段。

完成标准：单元测试覆盖规范状态表、active Run 竞态和重复创建。

### B0-B：把现有 SessionRunner 接入 Run 投影

目标文件：`zmzai-agent/framework/server/context.ts`、`zmzai-agent/framework/core/runtime/runner.ts`、`zmzai-agent/framework/core/events/`

- 每次 prompt 创建一个明确的 Run 记录或关联已有 continuation Run。
- Framework event 写入前/后同步产品 envelope，保证客户端可从快照恢复。
- `session.error`、permission、abort、lease recovery 写入可查询的 Run terminal reason。
- 保留 framework package 的通用性，不把 Mongo 产品模型依赖塞回 `packages/agent-framework`。

完成标准：同一 Task 并发提交两个 prompt 时只有一个 active Run，另一个进入队列；刷新和服务重启可重建 Run 快照。

### B0-C：冻结 Relay/Sandbox fixtures

目标文件：

- `zmzai-agent/lib/relay-agent-stream.ts`
- `zmzai-agent/lib/sandbox-execution.ts`
- `zmzai-sandbox/lib/agent-api.ts`
- `zmzai-sandbox/lib/sandbox-types.ts`
- `zmzai-relay/app/api/internal/agent/chat/route.ts`

- 为请求、响应、事件和错误定义版本化 fixture。
- 覆盖成功流、工具调用流、余额不足、上游中断、超时、取消、幂等重放和幂等冲突。
- fixture 同时用于 mock contract test 和真实服务 smoke test。

完成标准：Agent 使用 mock fixture 与真实本地服务各跑通一次，且 UI 不依赖 Relay/Sandbox 私有字段。

### B0-D：权限事实来源和旧数据边界

目标文件：`zmzai-agent/lib/workspaces.ts`、`zmzai-agent/framework/server/context.ts`、相关 API tests

- 固定 Agent 为 Project/Task/Approval 业务权限唯一判定者。
- 明确 Workspace 旧 owner 权限到 Project 角色的临时映射。
- 旧 TaskRun/ToolCall/ArtifactReference collection 只读；新 API 不回写旧 collection。
- 对跨用户 Task、Run、Artifact、Sandbox artifact 统一返回无存在性泄露的 404。

完成标准：Viewer/Member/Editor/Owner 矩阵先以测试 fixture 固定，具体 Project schema 可在 P1 完成。

### B0-E：P0 验收 fixture

目标文件：`zmzai-agent` 测试 fixture、`zmzai-sandbox` Agent API 测试

- 固定 `sales.csv` 输入、网页看板最小产物、qa-check JSON 和 zip manifest。
- 不先做完整 Chat-first 页面，只验证控制面、Sandbox、产物和恢复边界。
- 人为注入质量检查失败，验证中间 Artifact 保留和重试幂等。

完成标准：P0.1 开始前，CSV → web_app → qa-check → zip 的输入输出契约已可自动测试。

## 6. 明确不在本批次

- 不大规模迁移现有 Workbench UI。
- 不把 `SessionStatus.idle` 直接改名为 `Run.succeeded`。
- 不新增 Connector、Automation、Skills 市场或 Wide Research。
- 不把 Sandbox 的 in-memory artifact store 当作长期产品 Artifact 存储。
- 不让 `zmzai-cloud` 复制 Task/Run 状态机。
- 不触碰 `muzhi` 用户已有未提交改动。

## 7. B0 出口检查

只有全部满足后才能开始 P0.1：

- [ ] Task/Run/Session/SandboxRun 兼容映射表已进入代码测试或正式文档。
- [ ] Task 和 Run 状态转换表有非法转换测试。
- [ ] Task 最多一个 active Run 的数据库/服务双重保护已验证。
- [ ] Framework event、Relay event、Sandbox event 都能关联 `taskId/runId`。
- [ ] Permission、abort、lease recovery 的终态原因可查询。
- [ ] 幂等重放、冲突和 unknown side effect 有明确测试结果。
- [ ] 跨用户读访问不会泄露对象存在性。
- [ ] CSV → web_app → qa-check → zip fixture 已冻结。

## 8. 推荐实施顺序

```text
B0-A 状态/模型骨架
  → B0-B SessionRunner 投影
  → B0-C Relay/Sandbox 契约 fixture
  → B0-D 权限与旧数据边界
  → B0-E P0 验收 fixture
  → B0 出口复核
```

`B0-A` 和 `B0-C` 可以并行，但 `B0-B` 必须等状态和事件 envelope 确定后开始。B0 完成后进入路线图中的 `P0.1 控制面和恢复语义`，再开始 Chat-first 页面重构。
