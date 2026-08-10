# ZMZAI Agent Runtime v1 最终规格

> 状态：最终设计基线。仓库：`zmzai-agent`。Agent Loop 运行时依赖：`@earendil-works/pi-agent-core@0.84.1`，必须精确锁定此版本。

## 1. 目标

`a.zmzai.cloud` 是面向已登录 ZMZAI 用户的通用 Agent 工作台。用户在持久化 Workspace 中提出任务；Agent 读取已授权的上下文，只调用被声明的工具，生成文件修改提案，在需要时等待用户批准，并且仅能通过 `z.zmzai.cloud` 执行代码。

本产品不是托管版 OpenCode、Hermes 的克隆，也不是 Cloudflare OS 的 Fork。ZMZAI 自己拥有并负责关键可信边界：Relay、Workspace 版本、Tool Broker、审批和 Sandbox 策略。

## 2. 已锁定决策

- **Agent Loop：** 使用 `@earendil-works/pi-agent-core@0.84.1`。禁止使用 Pi Coding Agent CLI，以及 Pi 内置的文件系统、Shell、网络、模型提供商和凭据工具。
- **模型路径：** 每一次模型调用必须经过 `m.zmzai.cloud` Relay；不提供直连 OpenAI 的路径，不接受用户填写上游模型 API Key。
- **执行路径：** 代码只能通过 `z.zmzai.cloud/api/v1` 运行。Agent 服务自身不得执行用户或 Agent 生成的代码和 Shell 命令。
- **权威状态：** MongoDB 是 Workspace、版本、Task Run、事件、提案、工具调用、预算和审批的唯一事实来源。PI 的状态只是可重建的工作状态，不能成为持久化权威。
- **v1 部署：** 在现有香港服务器上运行模块化 Next.js/Node 服务。MongoDB 用作控制面和小型文本 Workspace 存储。v1 不依赖 Redis、PostgreSQL、MinIO、多节点调度或协同编辑。
- **目标用户：** 已登录的 ZMZAI 用户。v1 不包含多人协作、共享、定时任务、Webhook、连接器市场。

## 3. 架构

```text
浏览器
  -> a.zmzai.cloud Agent API + SSE
      -> Task Runtime
          -> PI Agent Core（短暂的多轮 Agent Loop）
              -> Relay Model Adapter
                  -> m.zmzai.cloud 内部 Agent Endpoint
              -> Tool Broker
                  -> Workspace Store + Revision Store
                  -> Proposal / Approval Store
                  -> ZMZAI Sandbox API
                  -> Web Fetch Policy（第二阶段）
```

浏览器使用正常的 ZMZAI Auth Session。Agent API 负责验证会话和所有面向用户的授权。Task Runtime 通过一个新的、使用服务身份认证的 Relay 内部接口访问模型，并携带 `userId`、`taskRunId` 与用户选定的公开模型。Relay 校验服务凭据，应用用户余额和模型策略，并记录使用量。Agent Runtime 不得保存浏览器 Cookie 或上游模型凭据。

## 4. PI 集成契约

PI 只负责以下循环能力：模型轮次、结构化工具调用解析、将工具结果重新注入上下文、取消和受限轮次执行。

ZMZAI 的 PI Adapter 必须提供：

- 基于 Relay 的模型传输层；
- 根据 Workspace Policy 动态生成的 Tool Registry；
- 持久化 Event Sink，用于记录文本增量、工具调用请求、工具结果、错误和终态；
- Context Loader，可由持久化消息、工具结果和当前提案状态重建一次运行；
- 由 Task Runtime 持有的 `AbortSignal`。

PI Adapter 必须拒绝当前 Workspace 未注册的任何工具调用，并在 Tool Broker 接收前验证输入 Schema。生产环境不得使用 PI 的 session JSONL、本地 Harness 工具、扩展和 Provider 配置。

## 5. 领域模型

```text
Workspace
  -> WorkspaceFile（当前文本 + 版本指针）
  -> WorkspaceRevision（不可变的已批准快照/差异）
  -> AgentSession（持久化会话元数据）
  -> TaskRun
      -> TaskEvent（单调递增序号）
      -> ToolCall
      -> ChangeProposal
      -> Artifact Reference
```

### Workspace

字段：`id`、`userId`、`name`、`description`、`currentRevisionId`、`defaultModel`、`approvalMode`、`createdAt`、`updatedAt`。

v1 每个文件仅存 UTF-8 文本，单文件最大 512 KiB，单个 Workspace 合计最大 10 MiB。二进制文件、大型产物和对象存储后置。所有路径必须规范化、相对 Workspace 根目录，且不得指向 `.env`、`.git`、凭据文件或通过符号链接逃逸。

### 版本与提案

`WorkspaceRevision` 不可变，包含父版本、作者、有序文件变更、差异摘要和时间戳。`ChangeProposal` 包含 `baseRevisionId`、候选变更、生成的 diff 和 `pending|approved|rejected|superseded` 状态。

文件写入不得直接修改当前版本。批准提案时，必须对 `Workspace.currentRevisionId` 执行 compare-and-set。版本不一致返回 `REVISION_CONFLICT`，Agent 必须重新读取并重新规划。

### Task Run

状态机：`queued -> running -> waiting_approval -> running -> succeeded|failed|cancelled`。

Task Run 必须具有单调递增事件序列、选定模型、预算、Workspace 基础版本、PI 上下文检查点、取消标记及失败时稳定的错误码。

v1 中一个 Workspace 同一时刻只允许一个活跃 Task Run。每个 Run 的最大限制为：12 次模型调用、20 次工具调用、10 分钟总墙钟时间、64 KiB 持久化事件文本，以及由 Relay 强制执行的模型预算。这些限制是服务端策略，不能只写进 Prompt。

## 6. Plan 与 Build 模式

每个任务开始时由用户选择一个模式：

- **Plan：** 仅允许 `read`、`list`、`search`。不能创建提案、调用 Sandbox、访问网络或产生外部副作用。
- **Build：** 在读取工具之外允许产生提案的 `write` 与 `edit`。Sandbox 执行必须针对每一个执行请求单独得到用户批准。

UI 必须在任务启动前显示模式。Plan 任务可以输出人类可读的方案，但不能自行提升为 Build。

### 6.1 前端交互工作台

v1 使用“对话负责意图，画布负责对象与审批”的单页工作台，而不是无限白板。桌面端由三个稳定区域组成：

- **左侧 Workspace 区：** Workspace、文件树、版本和 Task Run 历史。
- **中间对话区：** 用户消息、Agent 流式文本、简短工具活动和等待审批状态。
- **右侧画布区：** 当前任务关联对象的结构化投影，支持 `任务详情`、`文件`、`Diff`、`执行结果` 和 `产物` 五类视图。

画布不是第二套存储或协作状态。它只能由 Workspace Revision、ChangeProposal、Task Run、Task Event 和 Sandbox Artifact Reference 投影得到。浏览器刷新、切换设备或 SSE 重连后，画布状态必须能由这些持久化数据重建。

Agent 文本通过 `message.delta` 流式显示；工具调用只显示用户可理解的活动摘要，例如“正在读取 `src/app.ts`”或“已生成 3 个文件变更”。UI 不得请求、展示或持久化模型的原始思维链。

当 `proposal.created` 到达时，若用户没有固定当前画布，画布自动打开 Diff；当 `approval.required` 到达时，中间对话区和画布都显示同一个审批对象。用户选择文件、Diff、运行结果或点击“固定画布”后，后续工具事件不得抢占当前画布；仅以非阻塞提示提示有新对象可查看。

浏览器到服务端的状态变更使用 HTTP，并且携带 Idempotency Key；服务端到浏览器使用 SSE。前端按 `(runId, sequence)` 消费事件，并把持久化事件投影为界面状态，不能以组件内存作为任务真相。v1 不需要 WebSocket。

小屏幕下，左侧 Workspace 区改为抽屉，右侧画布改为与对话区互斥的全屏页签；审批操作必须始终可访问，并展示其对应的文件 Diff 或执行范围。

## 7. Tool Broker

Tool Broker 是唯一的工具实现边界。每一个工具必须声明：`name`、`version`、JSON 输入/输出 Schema、所需 capability、副作用等级、审批规则、超时和事件脱敏策略。

| 工具 | v1 行为 | 审批 |
| --- | --- | --- |
| `list` | 列出 Workspace 路径和元数据 | 不需要 |
| `read` | 读取允许的 Workspace 文本文件 | 不需要 |
| `search` | 在 Workspace 文件内进行受限文本搜索 | 不需要 |
| `write` | 在暂存提案中创建或替换文本 | 始终需要 |
| `edit` | 在暂存提案中应用经验证的补丁 | 始终需要 |
| `exec` | 基于临时提案快照提交 Sandbox 运行 | 始终需要 |
| `webfetch` | 第二阶段再实现；首个生产版本中禁用 | 不适用 |

所有工具结果遵循 `{ ok, data, error, metadata }`。稳定错误码包括：`PATH_NOT_ALLOWED`、`REVISION_CONFLICT`、`APPROVAL_REQUIRED`、`SANDBOX_FAILED`、`SANDBOX_TIMEOUT`、`MODEL_BUDGET_EXCEEDED`、`INSUFFICIENT_CREDITS`、`RUN_CANCELLED`。

在同一个 Agent 轮次中，Broker 必须维护由已批准文件和该 Run 暂存提案组成的 Shadow View。之后的 `read` 能读到暂存写入，其他 Run 只能看到当前已批准版本。这样可以保证 Agent 推理正确，同时不会将未批准变更全局暴露。

## 8. 审批与执行流程

```text
PI 请求 write/edit/exec
  -> Broker 校验 capability 和预算
  -> 持久化 ToolCall + ChangeProposal/Event
  -> TaskRun：waiting_approval
  -> 浏览器批准或拒绝
  -> 比较基础版本 / 应用提案或派发 Sandbox
  -> 持久化结果事件
  -> PI 以结构化结果继续运行
```

审批必须幂等。被拒绝的提案不得改变 Workspace 状态。Sandbox 只能获得生成的临时快照，不能访问权威 Workspace Store 或任何数据库凭据。Sandbox 输出和产物仅作为 Task Run 的引用保存，不能直接修改 Workspace 文件。

## 9. 事件、恢复与取消

每个事件必须先持久化，再通过 SSE 发出。事件字段为 `id`、`runId`、`sequence`、`type`、`at`、`data`。v1 至少定义 `run.started`、`message.delta`、`message.completed`、`tool.requested`、`tool.progress`、`proposal.created`、`approval.required`、`approval.resolved`、`sandbox.started`、`sandbox.output`、`sandbox.completed`、`sandbox.failed`、`run.completed`、`run.failed`、`run.cancelled`。`Last-Event-ID` 必须重放序号更大的事件，然后持续推送新事件。浏览器始终可以通过 `GET /api/runs/:runId` 恢复完整状态。

服务进程重启时，Runtime 将过期的活跃租约标记为可恢复，从持久化 Run 状态重建 PI 上下文，并且只在持久化工具边界恢复。它不得重复已确认的有副作用工具调用。待批准提案保持待批准；待处理的 Sandbox 调用必须先查询 Sandbox Run 状态，再恢复 PI。

取消必须幂等：持久化取消请求、中止 PI、必要时调用 Sandbox 取消，并且仅在所有活跃工具工作已完成或被隔离后才进入 `cancelled`。

## 10. v1 Public API

```text
GET  /api/workspaces
POST /api/workspaces
GET  /api/workspaces/:workspaceId
GET  /api/workspaces/:workspaceId/files
GET  /api/workspaces/:workspaceId/revisions

POST /api/workspaces/:workspaceId/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events
POST /api/runs/:runId/cancel

GET  /api/runs/:runId/proposals
POST /api/proposals/:proposalId/approve
POST /api/proposals/:proposalId/reject
POST /api/workspaces/:workspaceId/revisions/:revisionId/rollback
```

所有会改变状态的请求都必须携带 Idempotency Key。API 错误格式为 `{ code, error }`。授权失败不得泄露其他用户的 Workspace、Run、Proposal 或 Revision 是否存在。

## 11. 安全与运行控制

- 所有模型调用经过 Relay；不接受也不保存用户上游 Provider Key。
- Agent 进程不能拥有 Docker Socket、宿主机项目目录、Provider 凭据或 OpenSandbox 的直接凭据。
- Tool 输入、URL 输入、路径、模型输出和 Relay 响应必须在信任边界做 Schema 验证。
- 日志和事件必须脱敏密钥、会话、Token 和被标记为敏感的文件内容。
- 模型、轮次、工具、时间和输出预算必须在代码中强制执行，并持久化以供审计。
- Relay 的 `402` 必须持久化为 `INSUFFICIENT_CREDITS` 任务失败，并在 UI 中提供前往 `m.zmzai.cloud` 提额/账单页面的入口。

## 12. 可借鉴部分与明确排除项

Cloudflare OS 可借鉴持久化事件序列、临时状态、Shadow Edit、审批屏障和崩溃恢复；明确排除 Durable Objects、Gatekeeper/OAuth 平台、Worker Loader、Gadget Runtime、共享能力和多租户模型。

Hermes Agent 可借鉴迭代预算、上下文压缩、事件/日志脱敏、长期记忆候选能力和运维诊断。Hermes 不是基于 PI 的。v1 明确排除它的 Provider Key、宿主机 Shell 工具集、Cron、消息网关、自主学习循环和 Subagent 集群。

OpenCode 可借鉴 Plan/Build 产品模式、可见工具活动、编码任务 UX，以及未来的子 Agent 任务拆分。明确排除本地文件系统/Shell 权限、内建 Provider 配置、CLI/桌面运行时和其内部工具协议。

## 13. 交付顺序与验收标准

1. **基础层：** Auth 边界、Mongo Schema、Workspace/Revision Store、Relay 内部 Agent Adapter、PI Model Adapter、Task Run 事件。
2. **只读 Agent：** Plan 模式的 `list/read/search`、SSE、取消、模型/预算错误、重启恢复。
3. **提案工作流：** `write/edit`、Shadow State、Diff UI/API、批准/拒绝、版本冲突和回滚。
4. **Sandbox 工具：** 经过批准的临时快照、Sandbox 事件转发、取消和产物引用。
5. **加固：** 审计视图、事件脱敏、租约恢复演练、预算/负载测试、开发者 API 文档。
6. **第二阶段：** 通过专用、防 SSRF 的策略代理实现 `webfetch`。只有当核心审计链可靠后，才开始引入记忆候选和 Skills。

v1 的验收条件：已登录用户能够创建 Workspace；经 Relay 完成只读 Plan 任务；在 Build 中生成并批准文件 Diff；运行经批准的 Sandbox 代码；断线后无丢失地恢复事件；安全取消任务；并在故意重启服务后恢复 Task Run，且不重复执行任何副作用。
