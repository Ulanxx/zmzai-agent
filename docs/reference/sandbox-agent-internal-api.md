# Sandbox Agent Internal API v1

## 目的

`a.zmzai.cloud` 的 `exec` 工具必须把经用户批准的临时 Workspace 快照交给 `z.zmzai.cloud`。Agent、浏览器和 PI 均不持有 `sandbox_key`、OpenSandbox Key、Docker Socket 或宿主机权限。

## 已验证的现状

Sandbox 当前公开 v1 接口是：

- `POST /api/v1/runs`：使用 `Authorization: Bearer zsk_...`，请求体只接收 `task` 与 `model`。
- `GET /api/v1/runs/:runId`、`GET /api/v1/runs/:runId/events`、`POST /api/v1/runs/:runId/cancel`：同样绑定 `sandbox_key`。

这些接口适合外部开发者，但不能用于 Agent Runtime：Agent 不得要求或持有用户 `sandbox_key`，而且现有请求体不支持受控 Workspace Snapshot。

## 新增接口：`POST /api/internal/agent/runs`

### 认证

请求头必须包含 `Authorization: Bearer <SANDBOX_AGENT_SERVICE_SECRET_CURRENT>`。该密钥仅在 `a.zmzai.cloud` 和 `z.zmzai.cloud` 服务端保存，独立于用户创建的 `sandbox_key`。

### 请求

```json
{
  "userId": "Mongo User ObjectId",
  "taskRunId": "run_xxx",
  "requestId": "单次执行的幂等 ID",
  "snapshot": {
    "revisionId": "rev_xxx 或临时提案 ID",
    "files": [{ "path": "src/app.ts", "content": "..." }]
  },
  "command": { "program": "node", "args": ["src/app.ts"] },
  "limits": { "timeoutMs": 60000, "cpuMillis": 500, "memoryMiB": 512 }
}
```

Sandbox 必须校验路径、文件数量、总大小、命令白名单和资源上限。它将快照写入一次性隔离工作目录，执行后销毁目录。Mongo、Agent 源码、Docker Socket、Relay 服务密钥和宿主机目录均不可挂载进 Sandbox。

### 生命周期

`queued -> running -> succeeded|failed|cancelled`。Agent 后续通过同一内部服务认证调用：

```text
GET  /api/internal/agent/runs/:runId
GET  /api/internal/agent/runs/:runId/events
POST /api/internal/agent/runs/:runId/cancel
```

事件至少包含 `sandbox.started`、`sandbox.output`、`sandbox.completed`、`sandbox.failed`。取消必须幂等；`requestId` 重放不能创建第二个 Sandbox Run。

## 安全验收

1. 一个用户的 `taskRunId` 不能读取另一个用户的运行或产物。
2. 运行结果和产物只能作为 Agent Task Run 引用返回，不能直接写回 Workspace。
3. Runner 重启后，Agent 可通过状态接口对账，而非重新提交执行。
4. 任何请求体、事件或日志中都不出现 `sandbox_key`、OpenSandbox Key 或服务密钥。
