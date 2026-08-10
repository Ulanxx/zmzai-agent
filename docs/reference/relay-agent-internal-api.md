# Relay Agent Internal API v1

## 目的

`a.zmzai.cloud` 只能通过此服务端内部接口访问 `m.zmzai.cloud`。浏览器、PI、Workspace 文件和用户都不能提交 Provider Key 或 Relay API Key。

## 已验证的现状

Relay 已提供：

- `GET /api/v1/models`：用户 session 或 Relay API Key 认证的模型目录。
- `POST /api/v1/chat/completions`：用户 session、Relay API Key 或持有 `sandbox_key` 的内部 Sandbox 服务调用。
- `POST /api/internal/sandbox/chat`：仅给 Sandbox 使用，要求 `sandboxKey`；不得被 Agent 复用。

最后一项不符合 Agent 的安全模型，因为 `sandbox_key` 的授权范围仅限 Sandbox API。

## 新增接口：`POST /api/internal/agent/chat`

### 认证

请求头必须包含 `Authorization: Bearer <RELAY_AGENT_SERVICE_SECRET_CURRENT>`。Relay 支持当前和上一把服务密钥以便轮换。服务密钥只能存在于 `a.zmzai.cloud` 服务端环境变量。

### 请求

```json
{
  "userId": "Mongo User ObjectId",
  "taskRunId": "run_xxx",
  "requestId": "唯一且可重试的请求 ID",
  "model": "公开模型名",
  "messages": [{ "role": "user", "content": "..." }],
  "tools": [],
  "tool_choice": "auto",
  "stream": true,
  "max_tokens": 4096
}
```

`userId` 必须是 Relay 用户表中存在且可用的用户；Relay 以该用户余额、模型目录和计费规则执行请求。`taskRunId` 必须记录到 Usage/Audit 中，供追踪而非授权。`requestId` 重放时必须继承现有计费语义，不能重复扣费。

### 响应和错误

成功响应保持 OpenAI-compatible Chat Completion 或 SSE 格式。内部实现可调用现有 `/api/v1/chat/completions` 逻辑，但不得把 Agent 服务密钥伪装为用户 API Key。

| HTTP | 稳定 code | Agent 映射 |
| --- | --- | --- |
| 400 | `INVALID_BODY`、`MODEL_NOT_FOUND`、`MODEL_NOT_PRICED` | `MODEL_REQUEST_INVALID` |
| 401 | `INTERNAL_SERVICE_UNAUTHORIZED` | 配置故障，不重试 |
| 402 | Relay billing code | `INSUFFICIENT_CREDITS` |
| 409 | `REQUEST_IN_PROGRESS`、`REQUEST_ALREADY_PROCESSED` | 恢复或读取已有结果 |
| 429 | `RATE_LIMITED` | 可退避重试 |
| 502/503 | `UPSTREAM_ERROR`、`NO_CHANNEL` | 可退避重试 |

## 安全验收

1. Relay 拒绝不存在、禁用或未验证的 `userId`。
2. `taskRunId` 和 `requestId` 被记录，但它们不能跨用户读取 Usage。
3. 一次内部服务密钥不能调用 Sandbox 的解析接口，也不能成为用户公开 API Key。
4. `402` 在 Agent 中最终持久化为 `INSUFFICIENT_CREDITS`，且 UI 引导到 `m.zmzai.cloud`。
