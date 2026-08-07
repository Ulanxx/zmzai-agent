# ZMZAI Agent Runtime v0 设计规格

> 状态：已确认的 v0 设计
>
> 目标仓库：`zmzai-agent`
>
> 关联项目：`zmzai-sandbox`、`zmzai-relay`、`zmzai-auth`、`zmzai-db`

## 1. 一句话定义

ZMZAI Agent Runtime 是一个面向个人使用的通用 Agent 执行内核：用户在长期 Workspace 中提交任务，Agent 通过受控 Tool 完成任务，所有文件改动默认先形成 diff，用户批准后才写入 Workspace。

工作台负责呈现任务过程；Runtime 负责运行状态、工具调用、审批和产物。

## 2. v0 范围

### 2.1 必须支持

- 单用户、单服务器、多 Workspace。
- 用户手动提交任务。
- Agent 多轮工具调用。
- 长期 Workspace 文件与任务历史。
- Tool Broker 统一调度工具。
- `read`、`list`、`search`、`write`、`edit`、`webfetch`。
- 默认生成 diff，用户批准后写入 Workspace。
- 任务运行状态、工具调用日志、错误和产物记录。
- 可取消运行、可重试失败步骤、可查看历史 revision。
- 所有模型调用统一经过 `zmzai-relay`。
- 余额不足时返回可识别错误，并引导用户前往 `m.zmzai.cloud` 提额。

### 2.2 暂不支持

- 定时任务、Cron、Webhook 触发和后台编排。
- 用户直接填写上游模型 API Key。
- 官方 OpenAI 直连或其他供应商 SDK 直连。
- 多人协作、复杂分享权限和多租户计费。
- Gadget Runtime 和 Gadget 前端沙箱。
- 任意代码在 Agent 主进程内执行。
- 完整 Connector 市场。

## 3. 产品模型

```text
User
  └── Workspace
        ├── files
        ├── revisions
        ├── agent sessions
        ├── task runs
        ├── tool calls
        ├── approvals
        └── artifacts
```

### User

用户身份由 `zmzai-auth` 统一管理。Agent Runtime 不自行建立第二套登录体系。

### Workspace

Workspace 是长期项目空间，例如“知识库”“运营”“某个客户项目”。任务在 Workspace 中持续积累上下文、文件和产物，而不是每次任务创建临时空间。

每个 Workspace 至少包含：

- 唯一 ID、名称、描述和创建时间；
- 文件树和当前 revision；
- Agent 会话与任务运行；
- 已授权的 capability；
- 运行策略，例如默认模型和审批模式。

### Task Run

一次用户手动提交的任务称为 Task Run。Run 有独立状态、输入、事件流、工具调用和产物，不与聊天消息混为一体。

状态机：

```text
queued -> running -> waiting_approval -> running -> succeeded
                         |                         |
                         v                         v
                      cancelled                 failed
```

`waiting_approval` 可以恢复；`succeeded`、`failed`、`cancelled` 是终态。

### Revision

Workspace 的每次写入都产生可追溯 revision。Agent 先针对当前 revision 生成变更提案；批准后才创建新的正式 revision。Revision 必须支持查看 diff 和回滚到旧版本。

## 4. 总体架构

```text
React / Next.js 工作台
        |
        | HTTP + SSE
        v
Agent API
        |
        +--> Agent Orchestrator
        |        |
        |        +--> Relay Model Client ----> m.zmzai.cloud
        |        |
        |        +--> Tool Broker
        |                 |
        |                 +--> Workspace Store
        |                 +--> Web Fetch Policy
        |                 +--> Sandbox Runner (zmzai-sandbox)
        |                 +--> Connector adapters (later)
        |
        +--> PostgreSQL
        +--> Workspace object/file storage
```

v0 使用模块化单体。Agent API、Orchestrator、Tool Broker 和 Workspace Store 可以在同一个 Node.js 服务中运行；Sandbox Runner 是独立的执行边界。Redis、MinIO 和多节点部署不属于 v0 的前置依赖。

## 5. Agent Loop

Agent Loop 只负责以下事情：

1. 读取当前 Workspace、任务输入和历史上下文；
2. 从 Tool Registry 发现当前可用工具；
3. 调用 relay 获取模型输出；
4. 校验模型请求的工具名称和输入 schema；
5. 将工具调用交给 Tool Broker；
6. 把结构化工具结果回填给模型；
7. 在完成、失败、取消或等待审批时结束本轮。

Agent Loop 不直接接触：

- 数据库连接；
- 上游模型 API Key；
- 宿主机文件系统；
- Docker Socket；
- Connector 的长期凭证；
- 任意工具的供应商 SDK。

## 6. Tool Registry 与 Tool Broker

### 6.1 Tool 定义

每个 Tool 必须声明：

```text
name
version
description
inputSchema
outputSchema
capability
sideEffect: none | workspace_write | external_write | code_execution
approvalPolicy: never | proposed | always
timeout
networkPolicy
```

Agent 只看到当前 Workspace 已授权、并符合策略的工具。工具实现由 Broker 管理，Agent 不导入具体实现。

### 6.2 v0 内置工具

| Tool | 用途 | 默认策略 |
|---|---|---|
| `read` | 读取 Workspace 内文件 | 只读，不审批 |
| `list` | 查看 Workspace 文件树 | 只读，不审批 |
| `search` | 在 Workspace 内检索文本 | 只读，不审批 |
| `write` | 创建或完整写入文件 | 生成 diff，需审批 |
| `edit` | 以 patch 方式修改文件 | 生成 diff，需审批 |
| `webfetch` | 读取受控的公网 URL | 只读，受网络策略限制 |
| `exec` | 在 Sandbox Runner 中执行命令 | 需执行策略，默认无网络 |

`write` 和 `edit` 不直接写入正式 Workspace。它们生成变更提案，提案包含基础 revision、文件 diff 和预期影响。

### 6.3 工具结果

工具结果必须是结构化对象，至少包含：

```text
ok
data
error
metadata
```

错误必须包含稳定的 `code`，例如：

```text
PATH_NOT_ALLOWED
REVISION_CONFLICT
APPROVAL_REQUIRED
NETWORK_DENIED
SANDBOX_TIMEOUT
INSUFFICIENT_CREDITS
```

## 7. Workspace 文件与变更策略

### 7.1 路径策略

- 工具只能访问当前 Workspace 根目录下的路径。
- 必须在规范化路径后检查越界，不能只检查字符串前缀。
- 禁止通过符号链接逃逸到 Workspace 外。
- Agent 不能读取 `.env`、宿主机密钥或运行服务的环境变量，除非未来显式增加 capability。

### 7.2 变更流程

```text
Agent write/edit
  -> 读取当前 revision
  -> 在临时变更区生成 patch
  -> 返回 proposal + diff
  -> 用户批准
  -> 检查 revision 是否仍为基线
  -> 写入 Workspace
  -> 创建新 revision
```

如果基线 revision 已变化，不能静默覆盖，必须返回 `REVISION_CONFLICT` 并要求 Agent 重新读取和合并。

### 7.3 审批模式

- 默认模式：所有 `write`、`edit` 和 `exec` 产生审批或执行确认。
- 信任 Workspace：用户显式打开后，允许符合策略的文件写入自动落盘。
- 外部副作用：未来 Connector 的写入始终独立审批，不受 Workspace 信任模式自动放行。

## 8. Relay 边界

所有模型请求必须经过 `m.zmzai.cloud`。Agent Runtime 不支持官方 OpenAI 直连，也不内置任何供应商 SDK。

```text
Agent Runtime
  -> relay model id
  -> m.zmzai.cloud
  -> relay 管理的上游渠道
```

用户只能在 relay 用户端选择已经开放的模型。v0 不允许用户填写上游 API Key。

Runtime 需要依赖的 relay 能力：

- 模型目录；
- 流式对话；
- 用户身份绑定；
- 余额和额度校验；
- 用量记录；
- 余额不足的稳定错误。

余额不足时，Runtime 应保留任务失败状态和错误原因，并在工作台显示前往 `m.zmzai.cloud` 提额的入口。模型调用不应绕过 relay 进行降级直连。

## 9. Sandbox 依赖边界

`zmzai-agent` 只依赖 Sandbox Runner 的执行契约，不依赖 Docker、gVisor 或具体容器实现。

最小执行契约：

```text
createRun(input, policy) -> runId
getRun(runId) -> status
subscribeLogs(runId) -> event stream
cancelRun(runId) -> acknowledgement
collectArtifacts(runId) -> artifact list
```

执行输入必须引用已批准的 Workspace revision 或临时文件快照。Sandbox 不得直接修改正式 Workspace。执行结果通过日志、退出码和产物回传，由 Agent Runtime 决定是否创建 revision。

## 10. API 方向

v0 的 API 以任务和事件为中心：

```text
GET  /api/workspaces
POST /api/workspaces
GET  /api/workspaces/:workspaceId
GET  /api/workspaces/:workspaceId/files
GET  /api/workspaces/:workspaceId/revisions

POST /api/workspaces/:workspaceId/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events        # SSE
POST /api/runs/:runId/cancel

GET  /api/runs/:runId/proposals
POST /api/proposals/:proposalId/approve
POST /api/proposals/:proposalId/reject
POST /api/workspaces/:workspaceId/revisions/:revisionId/rollback
```

具体字段和鉴权方式在实现计划阶段冻结。API 不应把 Tool 的内部实现暴露给前端；前端消费的是任务事件、审批对象和结构化错误。

## 11. 安全与资源策略

### Agent Runtime

- 只通过 Tool Broker 访问文件、网络和执行环境。
- 所有工具调用写入审计事件。
- 任务必须支持取消和最大运行时长。
- 模型返回的工具名和参数必须经过 schema 校验。
- 不把上游 API Key、relay 长期密钥或 Connector 凭证放入模型上下文。

### Sandbox

v0 面向单用户，目标是防止 Agent 代码误伤宿主机和耗尽资源，不宣称已经达到不可信多租户隔离级别。默认策略：

```text
network: denied
timeout: 60s
cpu: 1 core
memory: 1 GiB
scratch disk: 1 GiB
processes: limited
output: limited
privileged: false
docker socket: unavailable
host mounts: unavailable
```

需要联网时，必须通过独立的受控出口能力，并使用域名白名单、超时、响应大小限制和审计记录。`webfetch` 与代码执行的联网权限不能混为一个全局开关。

## 12. 失败与恢复

- relay 余额不足：任务进入 `failed`，错误码为 `INSUFFICIENT_CREDITS`，保留已有日志和提案。
- 模型请求超时：保存当前事件，允许用户重试，不重复提交已批准的写入。
- 工具参数非法：返回结构化错误，让 Agent 修正；超过重试上限后结束任务。
- Workspace revision 冲突：阻止覆盖，要求重新读取当前文件。
- Sandbox 超时或崩溃：保留退出原因和日志片段，清理临时执行环境。
- 用户取消：停止当前工具调用，任务进入 `cancelled`，已批准的历史 revision 不回滚。

## 13. 验收标准

第一版 Agent Runtime 至少通过以下闭环：

1. 用户创建一个 Workspace。
2. 用户提交“读取一个目录里的资料，整理成 Markdown 报告并保存到指定位置”。
3. Agent 使用 `list`、`read`、`write` 完成任务。
4. `write` 先生成 diff，用户批准后才写入。
5. Workspace 产生可查看的新 revision。
6. 用户可以查看完整工具调用和任务事件。
7. Agent 通过 `exec` 在 Sandbox Runner 中运行一个 Node.js 检查脚本。
8. 沙箱不能访问网络、不能越过 Workspace 快照、超时后会被清理。
9. relay 余额不足时，任务停止并显示 `m.zmzai.cloud` 提额入口。
10. 用户可以取消运行，并在失败后查看可诊断的错误原因。

## 14. 实施顺序

```text
M1 运行模型：Workspace、Run、Event、Revision 数据结构
M2 Agent Loop：relay 客户端、工具发现、结构化工具结果
M3 文件工具：list/read/search/write/edit + diff/审批/回滚
M4 Sandbox 接入：exec 工具和 Runner 契约
M5 网络读取：webfetch 的 SSRF 与出口策略
M6 Connector：第一个只读外部服务
M7 Gadget：把 Agent 产物变成可运行应用
```

## 15. 已确认决策

| 决策 | 结论 |
|---|---|
| 产品定位 | 个人通用 Agent Runtime，不是先做多人平台 |
| Workspace | 长期项目空间，任务持续积累 |
| 任务触发 | v0 只支持手动提交，不支持定时任务 |
| 模型入口 | 所有请求统一经过 `zmzai-relay` |
| 官方 OpenAI | 不支持直连 |
| 用户 API Key | v0 不允许用户填写，由 relay 管理员配置 |
| 余额不足 | 引导用户到 `m.zmzai.cloud` 提额 |
| 文件写入 | 默认 diff + 审批，支持显式信任 Workspace |
| 代码执行 | 通过独立 Sandbox Runner，不能在 Agent 主进程执行 |
| 初始沙箱 | 单用户隔离，默认无网络、限时、限资源 |

