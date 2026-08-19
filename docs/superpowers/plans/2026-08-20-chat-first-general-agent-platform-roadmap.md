# Chat-first 通用智能体平台全局路线图

> 对应设计规格：[Chat-first 通用智能体平台设计](../specs/2026-08-19-chat-first-general-agent-platform-design.md)
>
> 范围：`zmzai` 全生态。主执行仓库为 `zmzai-agent`，其他仓库按跨仓库契约提供支撑。
>
> 目标：把当前已有的 Agent Runtime 能力，收敛成真实用户可以持续使用的通用任务执行器。

## 1. 路线判断

产品采用 `Chat-first + Agent Workbench`：

- 对话是主入口和控制方式。
- 计划、Subagent、Tool、审批和成果是对话中的结构化对象。
- 文件、浏览器、终端、代码、数据和成果预览按需出现在右侧工作区。
- 项目保存长期上下文，成果中心保存可复用交付物，自动化和连接器作为后续平台能力。

第一阶段不把“深度研究”作为产品定位。研究、PPT、网页、代码和数据任务都作为通用执行器的验证任务，其中“CSV → 网页看板 → Sandbox 质量检查”是 P0 的确定验收场景。

## 2. 当前起点

旧 Runtime v1 已经提供了相当多的工程底座：

- Relay Agent Adapter、模型目录和额度错误映射已有实现，待真实契约联调。
- Mongo Workspace、Revision、Run、Event、Idempotency 和 Lease 已有实现，待集成测试和生产验证。
- Plan 只读工作台、Build Diff/Proposal、审批、Revision CAS、Sandbox `exec`、实时执行输出、取消和 Lease Recovery 已有实现或本地链路验证。
- Sandbox 已有内部 Agent API、SSE、服务认证、demo provider 和产物回传方向；真实 OpenSandbox 容器和长期产物交付仍需验证。

现有底座不能直接视为 P0 完成，主要缺口是：

1. 现有 `Session / TaskRun / Workspace` 语义需要对齐新规格的 `Task / Run / Project`。
2. 当前工作台偏 Runtime/开发者控制台，需要重构成对话主流 + 结构化卡片 + 按需工作区。
3. `Task`/`Run` 的暂停、恢复、重试、分支、队列、检查点和幂等契约需要统一。
4. Subagent 需要从运行时事件投影为职责、状态、进度和汇总产出的用户对象。
5. P0 需要一个通用 `web_app` 预览与可下载 zip 的成果闭环。
6. 真实故障演练、OpenSandbox、权限和多用户隔离还不能只依赖本地 demo。

## 3. 交付分层

路线分为四个产品层级：

| 层级 | 目标 | 交付判断 |
| --- | --- | --- |
| B0 对齐与基线 | 让现有 Runtime 与新产品对象、状态和契约一致 | 没有两个并存的 Task/Run 语义 |
| P0 Agent Core | 完成 Chat-first 通用任务闭环 | 用户能从自然语言目标走到可预览/下载成果，并可恢复 |
| P1 平台化 | 把一次成功任务变成长期项目、能力和团队工作流 | 用户愿意重复使用并沉淀上下文 |
| P2 生态化 | 连接器、自动化、API 和协作规模化 | Agent 进入用户已有工作系统 |

不要在 P0 同时建设完整 Agent Builder、Skills 市场、邮件/Slack 入口和所有成果类型。

## 4. 批次 B0：对齐现有底座

目标是冻结跨仓库契约和产品对象，不新增面向用户的复杂功能。

### B0.1 运行时对象对齐

仓库：`zmzai-agent`、`zmzai-db`

任务：

- 建立 `Task` 作为持续用户目标，`Run` 作为一次执行尝试的明确映射。
- 确定现有 `Session`、`TaskRun`、`Workspace`、`AgentSession` 的兼容层和迁移策略。
- 实现一个 Task 最多一个 active Run 的约束。
- 明确 retry、resume、follow-up 创建新 Run；“另存为分支”创建新 Task。
- 为消息队列、`parentRunId`、`resumeCheckpointId`、`parentTaskId` 和 `sourceTaskVersionId` 预留字段。

完成标准：现有 Plan/Build/exec 流程可以映射到新对象，不需要前端自行推断状态。

### B0.2 状态和事件契约

仓库：`zmzai-agent`、`zmzai-db`、`zmzai-sandbox`

任务：

- 冻结 Task 状态：`draft`、`active`、`succeeded`、`failed`、`cancelled`。
- 冻结 Run 状态：`created`、`running`、`waiting_input`、`waiting_approval`、`paused`、`succeeded`、`failed`、`cancelled`。
- 区分 `waiting_input` 与 `waiting_approval` 的事件和 API。
- 增加 checkpoint、idempotency key、unknown side effect 和事件重放契约。
- 将现有 `session.status`、`run.resumed`、`tool.completed`、`artifact.upsert` 等事件映射到统一 envelope。

完成标准：状态转换表和非法转换测试齐全；刷新、断线和服务重启后状态不倒退。

### B0.3 服务契约冻结

仓库：`zmzai-relay`、`zmzai-sandbox`、`zmzai-agent`

任务：

- 版本化 Relay Agent Chat 契约、模型目录、额度、限流、取消和错误码。
- 版本化 Sandbox 执行、状态、取消、文件读取、产物清单和资源上限契约。
- 统一服务密钥轮换、请求幂等和内部 request ID。
- 为 `web_app` 预览、zip 下载和 `qa-check` 结果预留内部接口。

完成标准：Agent 使用 mock contract fixture 和真实服务各跑通一次；Relay/Sandbox 变更不会直接穿透 UI。

### B0.4 权限事实来源

仓库：`zmzai-auth`、`zmzai-db`、`zmzai-agent`

任务：

- Auth 只负责身份和登录会话。
- DB 发布 Workspace/Project/成员/角色结构。
- Agent 负责 Project 角色、ApprovalPolicy、ApprovalRequest 和 ApprovalGrant 的业务判定。
- Cloud 不复制权限判断，只提供产品入口。

完成标准：Viewer/Member/Editor/Owner 的 API 权限矩阵和高风险动作测试可执行。

## 5. 批次 P0：Chat-first Agent Core

P0 是一条垂直闭环，不是把所有页面同时做完。建议按下面顺序实施。

### P0.1 控制面和恢复语义

仓库：`zmzai-agent`，配合 `zmzai-db`、`zmzai-auth`

任务：

- 完成 Task/Run 状态机、单 active Run、队列、暂停、取消、重试和 continuation Run。
- 将 ApprovalRequest 与 ApprovalGrant 分离；明确批准、拒绝、过期和撤销结果。
- 在每个 ToolCall 完成、步骤完成和副作用前写 durable checkpoint。
- 为副作用动作统一 `taskId + runId + stepId + attempt` 幂等键。
- 对 unknown side effect 进入 `waiting_input`，不得自动重放。
- 为事件 Store、SSE replay 和 Lease Recovery 增加状态机集成测试。

验收：

- 在模型流、审批等待、Sandbox 在途三种场景重启服务，不重复副作用。
- 同一个 Task 不会同时运行两个 active Run。
- retry/resume/follow-up 均产生新 Run，历史事件和 Artifact 保留。

### P0.2 对话主界面和卡片系统

仓库：`zmzai-agent`、`zmzai-theme`，入口整合在 `zmzai-cloud`

任务：

- 将现有工作台重构为 Chat-first：左侧空间/项目/会话，中间对话，右侧可选工作区。
- 建立消息中的 PlanCard、ExecutionCard、SubagentSummaryCard、ToolSummaryCard、ApprovalCard、ArtifactCard、FailureRecoveryCard、CompletionCard。
- 普通任务默认不显示空的 Tool/Subagent 区域。
- Tool 调用按同类连续事件聚合；参数和结果摘要服务端脱敏后再展示。
- 计划支持查看、调整、跳过、重跑；用户可在对话中提出变更。
- 五种核心用户状态和暂停/取消状态使用明确的视觉和动作语言。

验收：

- 轻量文件任务首屏只有对话和结果，不出现开发者控制台感。
- 长任务能在同一条对话中看到目标、计划、当前动作、关键发现、需要决策的事项和成果。
- 任意卡片刷新后可由快照和事件重建，不依赖浏览器内存。

### P0.3 上下文与按需工作区

仓库：`zmzai-agent`、`zmzai-sandbox`、`zmzai-theme`

任务：

- 支持文件上传、项目级文件/指令上下文和任务级临时上下文。
- 右侧工作区先实现文件、代码/Diff、终端输出、网页预览和成果五种基础页签。
- 工作区默认跟随当前事件，用户固定后不被后续事件抢占。
- 预览和下载只走 Agent 鉴权，不暴露 Sandbox 服务密钥或内部路径。
- 生成 `web_app` Artifact：静态 HTML/CSS/JS 目录 + 受保护临时 preview endpoint + zip 下载。

验收：

- 用户能上传 CSV，Agent 能读取并在任务内引用。
- 用户固定某个文件/预览后，Subagent 或 Tool 事件不会强制切换焦点。
- `web_app` 预览默认只允许任务用户/项目成员访问，30 分钟过期。

### P0.4 Subagent 与 Tool 执行投影

仓库：`zmzai-agent`、`zmzai-theme`，必要时调整 `zmzai-sandbox`

任务：

- Subagent 仅由 Agent Runtime 产生，不开放用户编排。
- 每个 Subagent 有职责、输入摘要、状态、进度、结果和 parent Task/Run。
- 对话中只显示 Subagent 汇总；右侧详情显示单个 Subagent 和最近 Tool 活动。
- Tool 只展示安全摘要、耗时、状态、失败原因和 Artifact 引用。
- 支持有限并行和统一汇总，避免无限递归和上下文污染。

验收：

- 一个多步骤任务可以并行启动多个职责明确的 Subagent，并在 Task 中汇总结果。
- Tool 调用连续执行时不会生成 token 级或调用级日志瀑布。
- Subagent 失败不会让整个 Task 丢失其他已完成成果；Task 能继续或明确失败。

### P0.5 统一成果交付和质量检查

仓库：`zmzai-agent`、`zmzai-sandbox`、`zmzai-theme`

任务：

- 统一成果元数据：类型、标题、来源 Task/Run、预览、下载、大小、质量状态和权限。
- Sandbox 收集 `web_app` 目录并生成 zip；Agent 侧保存元数据和受控文件内容。
- `qa-check` 返回结构化 JSON，至少检查 HTML 可加载、核心指标存在、桌面和移动视口无溢出。
- 质量检查不通过时进入失败恢复，保留中间 Artifact；全部通过才允许 succeeded。
- 完成卡提供打开、下载、分享、继续修改、复制到 Project 和保存模板入口。

验收：

- CSV → web_app → qa-check → Artifact 下载全链路真实跑通。
- 人为制造质量检查失败后，从最近 checkpoint 重试不会重复已提交副作用。
- 成果可在刷新后重新预览和下载，跨用户访问返回不泄露存在性的 404。

### P0.6 真实用户试用和上线门槛

仓库：全生态，主责 `zmzai-agent`

任务：

- 准备 5 类任务样本：文件分析、网页生成、代码修改、数据看板、长任务研究。
- 建立任务完成率、失败恢复率、成果下载率、用户主动继续率和权限拒绝率指标。
- 执行断线、Relay 余额不足、Sandbox 超时/取消、Mongo 暂时不可用和服务重启演练。
- 完成真实 OpenSandbox 容器验证，退出 demo provider 作为 P0 生产验收依据。
- 在 `zmzai-cloud` 统一入口接入 Agent，确保登录、跳转和返回路径完整。

上线门槛：

- P0 验收任务连续跑通 3 次，至少覆盖成功、失败恢复和用户拒绝授权。
- 所有可见状态可刷新恢复，无重复副作用、越权读取或泄露服务密钥。
- 真实用户能在不选择模型、不配置 Agent 的情况下完成首个任务。

## 6. 批次 P1：平台化能力

P1 在 P0 Core 稳定后推进，重点是让用户持续回来，而不是继续堆执行工具。

### P1.1 Project 长期上下文

仓库：`zmzai-agent`、`zmzai-db`、`zmzai-auth`、`zmzai-theme`

- 项目概览、共享指令、资料库、任务列表、成果和项目活动。
- 项目级 ContextItem 与任务级临时上下文的可见性和优先级。
- Viewer/Member/Editor/Owner 权限在 UI 和 API 双重生效。
- “另存为分支”复制选定上下文/成果引用，不复制运行态和授权。

### P1.2 成果中心

仓库：`zmzai-agent`、`zmzai-theme`、`zmzai-cloud`

- 按项目、类型、任务、时间和标签查找成果。
- 文档、网页、代码、表格、PPT、图片的统一阅读器逐步增加。
- 成果版本、来源、质量状态、分享和复制到项目。
- 继续修改始终回到关联 Task，而不是在成果中心另建第二套编排。

### P1.3 Skills 与模板

仓库：`zmzai-agent`、`zmzai-db`、`zmzai-theme`

- 从成功 Task 保存目标、步骤、上下文、工具能力和交付格式。
- 系统按任务目标自动推荐 Skill；用户可以查看已使用能力和版本。
- Skill 版本、来源、权限和失败回滚。
- 暂不做开放市场，先做项目内和官方 Skill。

### P1.4 首个真实 Connector

仓库：`zmzai-agent`、`zmzai-auth`、`zmzai-db`、`zmzai-sandbox`

推荐顺序：浏览器登录态或 GitHub 二选一，依据 P0 用户任务数据决定。

- ConnectorBinding、OAuth/本地授权、项目范围和撤销。
- Connector action 映射为 ToolCall，并受 Task Approval 控制。
- 审计记录显示访问了哪个系统、做了什么动作和产出什么成果。

### P1.5 自动化最小闭环

仓库：`zmzai-agent`、`zmzai-db`、`zmzai-theme`

- 从成功 Task 保存模板。
- 先支持手动运行和单一时间触发，再扩展邮件/Webhook/项目事件。
- 每次触发创建新 Task 或明确关联 Run，不复用旧 Run。
- 自动化失败进入任务恢复模型，成果和用量可追踪。

## 7. 批次 P2：生态化

P2 只在 P1 验证用户复用后推进：

- Mail/Slack 任务入口。
- 多 Connector 组合和自定义 MCP Server。
- Manus 风格 Wide Research 并行集群。
- 面向开发者的 Agent API、Webhook 和结构化输出。
- 团队协作、共享任务、评论和更细粒度的协作权限。
- 用量、额度、成本、团队预算和管理后台。

## 8. 跨仓库任务总表

| 仓库 | B0 / P0 重点 | P1 / P2 重点 |
| --- | --- | --- |
| `zmzai-agent` | Task/Run 状态机、事件、恢复、Chat-first UI、卡片、Subagent、Artifact、Preview、QA | Project、成果中心、Skills、Connector、Automation、API |
| `zmzai-cloud` | 统一入口、登录跳转、Agent 产品入口、导航一致性 | 产品矩阵、团队工作区、全局搜索和跨产品入口 |
| `zmzai-sandbox` | 文件快照、exec、产物收集、web_app/zip、qa-check、真实 OpenSandbox | 浏览器/桌面执行、持久工作区、更强隔离和资源治理 |
| `zmzai-relay` | Agent Chat 契约、错误、取消、模型目录、额度和成本事件 | 更强路由、批量/并行额度、团队预算、API 配额 |
| `zmzai-db` | 共享 schema/types、索引、迁移契约 | Project/Automation/Connector/Skill/Artifact 扩展 |
| `zmzai-auth` | SSO、user/session、Project 成员身份桥接 | OAuth Connector、组织、团队和细粒度权限 |
| `zmzai-theme` | Chat-first 卡片、工作区、状态、成果、响应式 | 统一成果阅读器、协作、跨产品组件 |
| `muzhi` | 只保留成果/知识沉淀接口，不阻塞 P0 | 知识库同步、引用、长期记忆和内容工作流 |
| `zmzai-workos` | 暂不作为独立主线 | 评估是否复用 Project/Task/Artifact 作为工作空间产品 |

## 9. 依赖图与关键路径

```text
B0 对象/状态/契约冻结
  ├── Task/Run/Approval/Checkpoint 控制面
  ├── Relay/Sandbox adapter contract
  └── Auth/DB source of truth
            ↓
P0.1 控制面与恢复
            ↓
P0.2 Chat-first 卡片 ───────┐
P0.3 上下文/工作区 ──────────┼──> P0.5 成果交付与 QA
P0.4 Subagent/Tool 投影 ────┘             ↓
                                      P0.6 真实用户试用
                                              ↓
                              P1 Project / 成果 / Skills / Connector / Automation
                                              ↓
                                      P2 生态化入口和 API
```

关键路径：`B0 → P0.1 → P0.2/P0.3/P0.4 → P0.5 → P0.6`。

并行原则：

- `zmzai-theme` 可以在 B0 契约确定后并行做无状态卡片和工作区组件。
- `zmzai-sandbox` 可以并行准备 `web_app` 产物收集和真实 OpenSandbox 验证。
- `zmzai-relay` 可以并行冻结 Chat 契约和错误/额度事件。
- `zmzai-cloud` 只需在 P0.6 前完成入口整合，不应提前复制 Agent 工作台。
- `muzhi` 和 `zmzai-workos` 不在 P0 关键路径上。

## 10. 风险与决策门

| 风险 | 影响 | 决策门 |
| --- | --- | --- |
| 旧 Session/TaskRun 与新 Task/Run 并存 | UI、API 和迁移长期分叉 | B0 必须确定兼容层和唯一事实来源 |
| Sandbox 仍只有 demo provider 或单次 run_code | P0 交付无法证明真实可靠 | P0.6 前必须完成真实容器、产物和取消演练 |
| Tool/Approval 直接暴露运行时细节 | 用户觉得产品像调试台 | P0.2 以普通用户首屏测试为门槛 |
| 多个仓库各自实现权限 | 越权或审批失效 | B0 固定 Agent 为业务权限判定唯一来源 |
| 过早建设 Connector/Automation/Skills 市场 | 交付面扩张，核心体验不稳定 | P0 只保留接口预留，P1 依据用户复用数据决定 |
| 成果类型过多 | 预览器和存储复杂度失控 | P0 只交付 `web_app + zip`，其他类型后置 |
| 长任务成本和模型失败 | 用户不信任 Agent | P0 展示阶段产出、额度/错误状态和可恢复动作 |

必须重新评估路线的条件：P0 用户连续三次仍无法完成首个任务、失败恢复重复副作用、用户大量绕过 Agent 直接操作文件，或用户实际任务不需要长任务执行。

## 11. 产品验收指标

P0 先使用行为和可靠性指标，不用“模型更聪明”作为完成标准：

- 首个任务：用户无需选择模型或配置 Agent，即可提交并开始任务。
- 可理解性：执行中用户能在对话中找到当前阶段、下一步和需要自己决定的事项。
- 恢复性：刷新、断线、暂停、拒绝审批和工具失败后，任务仍可明确继续或结束。
- 交付性：成功任务至少产生一个可预览/下载成果，且成果能从完成卡继续修改。
- 安全性：越权访问、密钥泄露和已提交副作用重复次数为 0。
- 真实使用：邀请首批真实用户完成至少五类任务，记录完成率、恢复率、成果下载率和主动继续率。

## 12. 第一批执行清单

第一批只做 B0，不进入大规模 UI 改造：

1. 对照设计规格盘点现有 `Session / TaskRun / Workspace / Artifact` 模型和 API。
2. 产出兼容映射表和迁移策略，标明哪些字段复用、重命名或新增。
3. 为 Task/Run 状态和 Approval/Checkpoint 写状态机与集成测试。
4. 冻结 Relay Chat 和 Sandbox web_app/产物契约。
5. 确认 `zmzai-db` schema 发布方式和各仓库依赖版本。
6. 建立 P0 CSV → web_app → qa-check → zip 的测试 fixture，但不先做完整页面。
7. 输出 B0 复核结果，确认可以开始 P0.1。

B0 完成前，不开始大规模迁移旧 UI，也不新增第三方 Connector。
