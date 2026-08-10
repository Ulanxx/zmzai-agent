# 跨 Workspace 运行审计（2026-08-10 实现）

> 对应规格：`docs/superpowers/specs/2026-08-10-cross-workspace-run-audit-design.md`（已确认，待实现 → 已实现）。

## 交付内容

- `models/task-run.ts` 新增 `startedAt` / `finishedAt`：获得运行 lease 时写 `startedAt`，进入 succeeded/failed/cancelled 时写 `finishedAt`；waiting_approval 刻意不写 `finishedAt`，详情展示进行中累计时长。新增 `{ userId: 1, createdAt: -1 }` 索引支撑跨 Workspace 审计列表。
- 生命周期写入：`lib/agent-runtime.ts`（lease 获取、WORKSPACE_NOT_FOUND、终态、AGENT_RUNTIME_FAILED）与 `lib/task-runs.ts`（取消）。
- `lib/run-audit.ts`：查询/DTO 边界。参数归一化（range/workspaceId/status/cursor/limit）、`(createdAt, runId)` 不透明游标、服务端 `$group` 聚合 toolCount/failedToolCount、`durationMs` 仅由 `finishedAt - startedAt`（运行中 `now - startedAt`，缺时间戳返回 null）。DTO 不暴露 `_id`、`leaseOwner`、`activeWorkspaceKey`、`sessionId`、budget、事件预算字段。
- API：`GET /api/audit/runs`（游标分页）与 `GET /api/runs/:runId/audit`（run + ToolCall 按 requestedAt 升序 + Artifact 按 createdAt 升序，全集合 `userId + runId` 约束）。
- 页面：`/audit` + 工作台顶部导航“运行审计”入口。默认 7d、倒序；Workspace/状态/时间范围筛选；行内显示 Workspace、prompt 摘要、Plan/Build、状态、模型、创建时间、时长、工具数/失败数；右侧详情工具时间线 + 已脱敏失败摘要 + artifact 安全 payload 预览。运行中任务先读快照再订阅 `/api/runs/:runId/events`，事件按 `toolCallId`/`artifactId` 确定性合并，终态后重载列表刷新状态与计数；历史终态任务不保持 SSE。

## 测试

- `lib/run-audit.test.ts`（35 例）：用 `vi.mock` + 内存 store 验证用户/Workspace/状态/时间范围约束、游标分页无重复无跳过（含 createdAt 并列）、聚合统计、详情不越权、DTO 字段白名单、时长规则。
- `app/api/audit/runs/route.test.ts` 与 `app/api/runs/[runId]/audit/route.test.ts`（7 例）：UNAUTHENTICATED / INVALID_QUERY / WORKSPACE_NOT_FOUND / RUN_NOT_FOUND 不泄露存在性 / 成功返回。
- `models/task-run.test.ts` 新增审计索引断言。
- 验证：`pnpm run typecheck`、`pnpm run lint`、`pnpm test`（66 例全绿）、`pnpm run build`（`/audit` 与两个新 API 路由注册成功）。

## 备注

- 前端交互（空状态、筛选、SSE 更新工具状态）按仓库现状以手工验收为准，仓库尚无 jsdom/Testing Library 前端测试设施。
- 线上需通过现有部署流程让 Mongoose 自动同步 `userId+createdAt` 索引；`startedAt`/`finishedAt` 只影响新运行，历史记录时长显示“—”。
