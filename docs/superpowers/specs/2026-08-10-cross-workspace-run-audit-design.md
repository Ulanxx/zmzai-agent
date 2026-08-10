# 跨 Workspace 运行审计设计

> 产品：`a.zmzai.cloud`。仓库：`zmzai-agent`。状态：已确认，待实现。

## 目标

提供一个面向当前用户的跨 Workspace 运行审计页。用户可以先按任务查看 Agent 的执行历史，再展开任务了解每次工具调用、失败原因、耗时与关联产物。页面刷新后必须从 Mongo 持久化投影恢复，不能依赖仍在连接的 SSE。

## 非目标

- 不提供组织级、管理员级或其他用户的数据访问。
- 不在本期增加统计仪表盘、导出、重试任务或全文检索。
- 不重复存储原始工具参数与原始结果；只展示现有安全摘要和受限 artifact payload。

## 页面与交互

新增 `/audit` 页面，并在 Agent 顶部导航提供“运行审计”入口。

页面由任务列表和任务详情组成：

- 默认范围为最近 7 天，按 `createdAt` 倒序；失败、取消任务在同一时间排序内明确标识。
- 筛选项包括 Workspace、运行状态、时间范围；第一期时间范围为最近 24 小时、7 天、30 天。
- 每行显示 Workspace 名称、prompt 摘要、Plan/Build、状态、模型、创建时间、执行时长、工具总数、失败工具数。
- 点击任务后，在右侧详情显示任务终态与失败码，并按 `requestedAt` 排列 ToolCall 时间线。
- 工具节点显示名称、参数摘要、状态、标签、结果摘要和耗时；失败节点显示已脱敏的错误摘要。
- 关联 artifact 显示标题与类型，点击后展示现有安全 payload 预览；不提供原始日志下载。
- 查看运行中任务时，先读取审计快照，再订阅既有 `/api/runs/:runId/events`；新事件只更新当前详情，列表状态和计数随之刷新。历史终态任务不保持 SSE 连接。

## 数据与 API

所有端点必须先获取当前用户，并以 `userId` 作为查询条件。

### `GET /api/audit/runs`

查询参数：

- `range`: `24h`、`7d`、`30d`，默认 `7d`。
- `workspaceId`: 可选，必须属于当前用户。
- `status`: 可选任务状态。
- `cursor`: 可选，基于 `(createdAt, runId)` 的不透明游标。
- `limit`: 1 到 50，默认 30。

响应返回 `runs` 与下一页 `cursor`。列表固定按 `{ createdAt: -1, runId: -1 }` 排序；续页条件为 `createdAt < cursor.createdAt`，或 `createdAt === cursor.createdAt && runId < cursor.runId`，且不包含游标本身。每个 run 包含 TaskRun 公共字段、Workspace 名称，以及从 ToolCall 聚合得到的 `toolCount`、`failedToolCount`、`durationMs`。聚合必须在服务端完成，前端不得加载所有工具调用后自行计算。

### `GET /api/runs/:runId/audit`

返回单个用户拥有的 TaskRun、按 `requestedAt` 升序的 ToolCall，以及按 `createdAt` 升序的 ArtifactReference。ToolCall DTO 必须包含 `toolCallId`；Artifact DTO 必须包含 `artifactId` 与 `toolCallId`，以便详情快照与后续 SSE 事件可确定性合并。Artifact 只返回其既有截断 payload；不存在或不属于当前用户的 run 返回 404，禁止泄露存在性。

定义稳定 DTO，避免将 Mongoose `_id`、内部锁、lease、事件预算和原始敏感字段暴露给客户端。

## 服务端边界

新增 `lib/run-audit.ts` 作为查询和 DTO 映射边界：

- 负责参数归一化、权限范围、游标、Run/ToolCall/Artifact 查询和计数聚合。
- 复用现有 `TaskRunModel`、`ToolCallModel`、`ArtifactReferenceModel`；不得重新从 TaskEvent 解析历史。
- 详情读取的三个集合必须受同一 `userId + runId` 约束。
- TaskRun 新增 `startedAt` 与 `finishedAt`。任务获得运行 lease 时写入 `startedAt`；进入 `succeeded`、`failed` 或 `cancelled` 时写入 `finishedAt`。`durationMs` 仅由 `finishedAt - startedAt` 计算；运行中任务由当前时间减 `startedAt` 计算。等待审批不写入 `finishedAt`，因此详情明确展示为进行中的累计时长。历史记录缺少时间戳时返回 `durationMs: null`，页面显示“--”，不得回退到 `updatedAt`。

## 错误与空状态

- 未登录返回既有 `UNAUTHENTICATED` 响应。
- 非法筛选参数返回 `INVALID_QUERY` 400。
- Workspace 不属于当前用户返回 404。
- 列表无记录显示“所选范围内没有任务记录”。
- 工具投影尚未写入时，任务详情显示“暂未产生工具调用”，而不是任务失败。
- SSE 中断不影响已加载审计内容；运行中任务显示恢复状态并依赖现有 Last-Event-ID 机制重连。

## 测试与验收

- 查询层验证用户、Workspace、状态和时间范围都被正确约束；游标分页无重复、无跳过。
- 聚合正确统计工具总数、失败数和由执行时间戳定义的 Run 时长；缺少新时间戳的历史任务显示空时长。
- 详情 API 不向其他用户返回 Run、ToolCall 或 ArtifactReference。
- DTO 不包含 `_id`、`leaseOwner`、`activeWorkspaceKey`、原始工具输出或密钥。
- 审计页可加载空状态、筛选列表、打开终态任务、打开运行中任务并通过 SSE 更新工具状态。
- 现有 Workbench 的单 Workspace 历史与事件回放不回归。

## 实施顺序

1. 实现 `lib/run-audit.ts` 及其查询、分页和 DTO 单元测试。
2. 增加审计列表和详情 API 路由测试。
3. 新增 `/audit` 页面及导航入口，完成列表、筛选和详情交互。
4. 复用现有 TaskEvent 投影与 SSE，补充运行中详情刷新测试。
