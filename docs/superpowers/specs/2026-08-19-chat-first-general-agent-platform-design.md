# Chat-first 通用智能体平台设计

**状态：** 已确认的产品设计基线

**范围：** `zmzai-agent` 主产品交互，以及 `zmzai-cloud`、`zmzai-sandbox`、`zmzai-relay`、`zmzai-db`、`zmzai-auth`、`zmzai-theme`、`muzhi` 的协作边界。

## 1. 产品定位

ZMZAI 是一个以对话为主入口的通用任务执行器。用户只需要描述目标，系统负责理解目标、制定计划、选择能力、调用工具、持续执行、请求必要确认，并交付可使用的成果。

核心体验结合三类产品特征：

- 像 ChatGPT / ZCode 一样自然地通过对话表达意图、补充要求和继续修改。
- 像 Manus 一样执行长任务、并行委派、操作浏览器和生成多种成果。
- 像开发工作台一样提供可追踪、可恢复、可审计的执行过程，但不把底层日志强迫展示给普通用户。

第一阶段不把研究、写 PPT、数据分析或代码生成中的任何一个场景作为平台定位。它们都是通用任务能力的验证场景。深度研究可以作为 Skill 或任务模板存在。

## 2. 核心交互原则

### 2.1 对话是主轴

任务详情页的中心区域是对话主流。用户通过消息发起目标、补充上下文、调整方向、回答确认和继续修改。计划、执行状态、Subagent、Tool、审批和成果以对话内结构化卡片出现。

任务计划和执行过程不是独立于对话的第二套产品。它们必须能被用户用自然语言修改，例如“跳过第三步”“只比较有公开 API 的产品”“先不要部署”。

### 2.2 渐进式披露

普通用户默认看到目标、当前进展、阶段产出和需要决策的事项。模型 ID、原始工具参数、完整事件、调试日志和内部上下文只在专业或开发者详情中展示。

### 2.3 任务可恢复

停止、失败、断线、服务重启和用户离开页面都不能让已产生的工作消失。用户应能从失败步骤继续、重试某一步、修改后重跑、保留当前结果并创建分支。

### 2.4 成果优先于日志

任务完成必须形成明确的交付卡，包含成果摘要、质量状态、预览或访问方式、下载/分享/继续修改等操作。执行日志是证据和诊断材料，不是默认交付物。

### 2.5 权限可理解且可追踪

Agent 请求权限时必须说明动作、影响范围、持续时间和可撤销方式。高风险动作使用任务级 Approval；授权和用户决定进入任务历史。

## 3. 信息架构

一级导航固定为：

```text
首页 / 新对话
任务
项目
成果
自动化
连接器
```

高级入口放在账户、项目设置或开发者区域：模板 / Skills 管理、团队权限、用量与账单、开发者审计、模型和策略设置。

### 3.1 首页 / 新对话

职责是让用户立即开始工作，不要求先理解 Agent 配置。

模块：

- 目标输入：自然语言、文件、链接、图片和上下文引用。
- 最近工作：正在运行、等待确认和最近完成的任务。
- 项目入口：打开已有项目并继承上下文。
- 少量场景模板：只作为示例和加速入口，不成为任务类型限制。

不在主流程中强制展示：模型选择、最大步骤、完整 Agent 系统提示词、原始运行审计。

### 3.2 任务详情

职责是完成一次用户任务。

模块：

- 对话主流：用户消息、Agent 回复和结构化卡片。
- 计划卡：步骤、状态、阶段产出；支持查看、调整、跳过、重跑。
- 执行卡：当前动作、简短进度、耗时和可理解的结果摘要。
- Subagent 汇总卡：只有发生委派或并行时出现，展示职责、状态和产出。
- Tool 活动摘要：连续同类工具调用自动聚合；关键失败、权限请求和产出主动浮出。
- Approval 卡：说明需要确认的动作及影响，提供一次性或任务级授权选择。
- 成果卡：预览、下载、分享、继续修改、加入项目和保存为模板。
- 可选工作区：按任务需要显示文件、浏览器、终端、代码/Diff、图片/PPT、数据表或最终成果。
- 继续输入：始终支持自然语言补充要求、暂停、调整计划和继续任务。

任务页不承担项目成员管理、全局连接器目录和自动化总管理。

### 3.3 项目空间

职责是让多个任务共享长期上下文。

模块：

- 项目目标和共享指令。
- ContextItem：文件、链接、知识、连接器结果和项目级偏好。
- 项目内任务列表和运行状态。
- 项目成果、模板和可复用资产。
- 成员、角色和项目权限。
- 项目级自动化。

项目不是简单文件夹。任务可以读取项目上下文，但任务级临时上下文必须与项目长期内容区分展示和管理。

### 3.4 成果中心

职责是查找和使用已经产出的结果。

模块：

- 按项目、类型、时间、任务和标签筛选成果。
- 统一成果阅读器，支持文档、网页、代码、表格、PPT、图片、数据和报告。
- 预览、下载、分享、继续修改、复制到项目、保存版本和删除。
- 成果来源、生成任务和质量状态。

成果中心不重新编排任务过程。需要修改时回到关联任务继续对话。

### 3.5 自动化

职责是把成功任务转化为可重复工作。

模块：

- 从任务保存模板：目标、步骤、上下文、工具能力和交付格式。
- 定时、邮件、Webhook、项目事件和手动触发器。
- 运行记录：状态、耗时、额度、成果和错误。
- 暂停、编辑、复制和删除自动化。

首次任务不应被迫进入复杂工作流搭建。

### 3.6 连接器

职责是管理 Agent 可以访问的外部系统和授权范围。

初期扩展点包括浏览器、文件、GitHub、Notion、Slack、邮箱、MCP Server 和自定义数据源。

模块：

- 连接目录。
- 已连接、待授权、过期和已撤销状态。
- 用户、项目和任务级权限范围。
- 最近使用和撤销入口。

连接器页不执行具体业务动作；业务动作发生在任务中并受任务级权限控制。

## 4. Task / Subagent / Tool 交互模型

三者必须使用不同的信息密度：

| 对象 | 面向谁 | 默认展示 | 展开内容 |
| --- | --- | --- | --- |
| Task | 用户目标 | 目标、计划、总进度、关键决策、成果 | 任务历史、Run、分支和完整状态 |
| Subagent | 职责与并行 | 负责什么、状态、进度、产出摘要 | 独立上下文、子任务消息和相关成果 |
| Tool | 原子动作与审计 | 聚合后的动作摘要、状态、耗时 | 脱敏参数摘要、结果摘要、错误和事件 |

规则：

- 普通任务不主动显示 Subagent；只有实际发生委派或并行时显示。
- Subagent 使用职责命名，例如“产品研究 A”“数据校验”，不制造无意义人格。
- 连续同类 Tool 调用自动聚合，避免日志瀑布。
- 对话中最多展开一层；更深细节进入右侧执行详情。
- Tool 的安全摘要和结果摘要由服务端生成，不能由前端从模型文本推断。

## 5. 任务生命周期

所有任务详情页必须支持五种用户可见的核心状态：任务开始、执行中、等待确认、失败恢复、完成交付。暂停和取消是跨这些核心状态的控制状态。

### 5.1 Task 与 Run 的规范状态

`Task` 是持续的用户目标和对话容器；`Run` 是一次具体执行尝试。Task 最多同时拥有一个 active Run。Task 的用户可见状态由其最新 Run 和未消费消息派生，Run 的执行状态是后端状态机的权威来源。

Task 状态：

| 状态 | 是否终态 | 含义 |
| --- | --- | --- |
| `draft` | 否 | 已创建目标，但没有 active Run |
| `active` | 否 | 有一个 Run 处于执行、等待输入/审批或暂停 |
| `succeeded` | 是（当前版本） | 最近一次 Run 达到交付条件；显式后续修改会重新打开 Task |
| `failed` | 是（当前版本） | 最近一次 Run 无法继续；显式重试或调整会重新打开 Task |
| `cancelled` | 是（当前版本） | 用户或系统取消了当前目标；显式恢复会重新打开 Task |

Run 状态：

| 状态 | 是否终态 | 含义 |
| --- | --- | --- |
| `created` | 否 | Run 已建立，尚未开始模型或工具调用 |
| `running` | 否 | Run 正在执行 |
| `waiting_input` | 否 | Agent 需要用户补充信息，不涉及授权判断 |
| `waiting_approval` | 否 | 高风险动作或关键计划变更等待有权用户批准 |
| `paused` | 否 | 用户暂停，当前 Run 不再启动新的动作 |
| `succeeded` | 是 | Run 交付完成 |
| `failed` | 是 | Run 无法继续 |
| `cancelled` | 是 | Run 被取消 |

规范转换：

```text
Task draft → active → succeeded | failed | cancelled
Task succeeded / failed / cancelled → active (explicit follow-up/retry/resume, new Run)

Run created → running
Run running → waiting_input | waiting_approval | paused | succeeded | failed | cancelled
Run waiting_input → running | paused | cancelled
Run waiting_approval → running | paused | cancelled
Run paused → cancelled
Run failed / cancelled / succeeded → (explicit follow-up/retry/resume) new Run(created)
```

所有 retry、resume 和 follow-up 都创建新的 Run，并设置 `parentRunId` 和 `resumeCheckpointId`；不会把已终态 Run 原地改回 `running`，而是先把 Task 从当前版本终态显式重开为 `active`。暂停只保留原 Run 为 `paused`，点击继续时创建 continuation Run。Task 的 `active` 状态表示 continuation Run 已建立或当前仍有未完成的控制动作。

队列和并发规则：

- 普通用户消息挂在 Task 上，状态为 `queued`，按 FIFO 在 Run 的安全检查点消费；它不直接改变已完成的 ToolCall。
- Task 同时最多一个 active Run；新的执行请求在已有 Run 结束前只能排队，不能隐式并发。
- “暂停”在当前 ToolCall 完成后生效；“取消”立即阻止下一次动作，并对正在进行的动作执行尽力取消。
- “修改计划”先生成计划变更事件和确认卡；确认后从最近检查点创建 continuation Run。
- “另存为分支”创建新 Task，并设置 `parentTaskId` 和 `sourceTaskVersionId`；它复制用户选定的 ContextItem 和 Artifact 引用，但不复制 active Run、Approval grant、queued 消息或事件。新 Task 必须重新创建自己的第一条 Run。

### 5.2 任务开始

Agent 总结目标和范围，给出简短可编辑计划，并等待用户开始执行或补充要求。轻量任务可以自动开始，但仍需在对话中留下计划摘要。

### 5.3 执行中

对话中显示当前动作、阶段进度和阶段产出；右侧工作区按需显示当前预览或执行现场。

执行中的新消息采用明确的队列策略：

- 普通补充消息进入 `queued`，不打断当前 ToolCall；当前 Run 到达安全检查点后，由 Agent 按顺序消费。
- 用户发送“暂停”或点击暂停时，系统在当前 ToolCall 完成后进入 `paused`，不启动新的动作。
- 用户明确要求“停止当前动作”时，系统尝试取消当前 Run；已完成的副作用和成果保留。
- 用户要求“修改计划”时，消息进入队列，并在安全检查点生成计划变更卡；变更获用户确认后继续或创建新的 Run。
- 用户要求“重新开始”时，创建新的 Run；不覆盖原 Run 的事件和成果。

### 5.4 等待确认

`waiting_input` 和 `waiting_approval` 在界面上都属于“等待确认”核心状态，但必须使用不同卡片和 API：前者由任何有权继续任务的成员补充信息即可恢复；后者只有 Project `Editor` 或以上角色可以批准高风险动作。Approval 卡必须说明动作、影响、范围、授权时长和拒绝后的替代路径。

ApprovalRequest 的结果规范为：

- `approved`：按请求范围创建 ApprovalGrant，Run 恢复为 `running`。
- `rejected`：不创建 Grant；若动作是必需动作，Run 进入 `failed`，错误码为 `APPROVAL_REJECTED`；若 Agent 声明了安全替代路径，则 Run 可以记录拒绝事件并继续替代路径。
- `expired` 或 `revoked`：阻止新的高风险动作；Run 进入 `waiting_approval` 或 `failed`，由 Agent 根据是否存在替代路径决定，但不得自动扩大权限。

### 5.5 失败恢复

失败卡必须说明失败步骤、已尝试次数、已保留成果和建议动作。支持重试、换方案、稍后继续、从快照恢复和保留当前结果开新分支。

### 5.6 完成交付

完成卡必须包含结果摘要、质量检查、访问方式、产物列表和后续动作。用户可以打开、下载、分享、继续修改、保存模板或复制到项目。

### 5.7 检查点、幂等和恢复

Run 在以下边界写入 durable checkpoint：每个 ToolCall 完成后、每个计划步骤完成后、以及任何可能产生外部副作用的 ToolCall 启动前。检查点至少包含：

- 最近事件 sequence 和 Run 状态。
- 已完成步骤、ToolCall idempotency key 和安全结果摘要。
- Workspace/Project 输入快照引用和已生成 Artifact 引用。
- 当前 Plan 版本、队列游标和有效 Approval grant 引用。

每个有副作用的动作必须带稳定的 `idempotencyKey = taskId + runId + stepId + attempt`。恢复时先检查已持久化的 ToolCall 和 Sandbox 结果，再决定是否重放；已确认成功的动作不得再次执行。若外部系统返回结果不确定，动作标记为 `unknown`，任务进入 `waiting_input`，要求用户确认后续处理，不得假设成功或失败。

事件、检查点和 Artifact 引用必须先持久化成功，再向客户端发布“步骤完成”事件。刷新或断线恢复先读取最新快照，再从其 sequence 之后重放事件；客户端按 sequence 去重。

## 6. 产品对象模型

用户可理解的对象和内部对象对应如下：

```text
Workspace
└── Project
    └── Task / Conversation
        └── Run
            ├── Subagent
            ├── ToolCall
            ├── Approval
            └── Event
        ├── Artifact
        ├── Automation
        ├── ConnectorBinding
        └── SkillBinding
```

- Workspace：个人或团队的资源、成员、额度和全局策略边界。
- Project：长期上下文、任务历史、成员和可复用资产。
- Task / Conversation：用户提出的一个持续目标，也是 Chat-first 的主对象。
- Run：一次具体执行尝试。重试、继续和后续修改可产生新的 Run，并仍属于同一 Task；另存为分支会创建新的 Task。
- Subagent：有独立职责和上下文的执行单元。
- ToolCall：一次原子工具动作。
- Approval：用户对高风险动作或关键决策的确认记录。
- ApprovalRequest：挂在当前 Run 上的一次待处理请求，记录动作、影响、请求人和批准结果。
- ApprovalGrant：由 ApprovalRequest 批准产生的短期授权，属于 Task 的授权集合，但必须绑定来源 Run、动作类型、资源范围、预算和过期时间。
- Event：可排序、可重放、可审计和可恢复的状态变化。
- Artifact：可预览、下载、修改、分享和沉淀的成果。
- ContextItem：任务或项目可引用的文件、链接、知识、连接器结果和指令。
- Automation：从 Task 保存的模板和触发配置；每次触发创建一个新的 Task 或关联 Run，不复用旧 Run。
- ConnectorBinding：Workspace/Project 对外部连接器的授权绑定；Task 只能引用已授权且在任务 Approval 范围内的动作。
- SkillBinding：项目或任务使用的能力版本和配置；系统可以自动选择，用户可以在详情中查看。
- ApprovalPolicy：Workspace/Project 对高风险动作的默认规则；实际一次授权仍落在 Task 的 Approval 记录上。

UI 使用“工作空间、项目、对话、任务、成果”；代码和审计使用 Workspace、Project、Task、Run、Subagent、ToolCall、Approval、Event、Artifact。

## 7. 权限模型

基础角色：

| 角色 | 能力 |
| --- | --- |
| Viewer | 查看项目、任务进度和成果；不能发送消息或执行高风险动作 |
| Member | 创建和继续任务、上传资料；连接器和高风险动作仍需确认 |
| Editor | 修改项目上下文、成果和自动化，并分享项目 |
| Owner / Admin | 管理成员、连接器、策略、额度、账单、审计和删除 |

权限作用域为 `Workspace → Project → Task → Action`。基础读写由角色控制；浏览器登录态、公开部署、发送邮件、写入外部系统、执行命令等动作必须额外经过 Task 级 Approval。

Approval 需要支持：

- 仅本次动作授权。
- 当前任务内同类动作授权，并带命令、时间或资源预算。
- 拒绝并提供反馈。
- 撤销当前任务的持续授权。
- 服务重启和任务恢复后的授权状态校验。

审批人必须是 Task 所属 Project 的 `Editor` 或更高角色；`Member` 只能提交反馈，不能批准高风险动作。Workspace Owner/Admin 可以在策略允许时代表项目审批。Task 级授权不能扩大 ConnectorBinding 的外部权限，也不能越过 Workspace 的安全策略。

ApprovalRequest 默认只批准当前 Run 的一次动作。任务级持续授权必须显式选择，并绑定动作类型、资源范围、命令数量/墙钟时间和过期时间；同一 Task 的 continuation Run 只有在 grant 未过期、动作范围未扩大、Project 角色仍有效且 `allowContinuation=true` 时才可继承剩余预算。计划变更、角色变化、ConnectorBinding 变化或资源范围扩大都会使 grant 失效；分支 Task 永不继承。取消 Task、取消 Run 或撤销授权会立即阻止新的高风险动作；已经启动的动作只能尽力取消，最终结果必须记录为 succeeded、failed 或 unknown。

## 8. 跨仓库职责与事实来源

| 仓库 | P0 职责 |
| --- | --- |
| `zmzai-agent` | Chat-first 任务 UI、Task/Run 状态机、任务编排、事件投影、Subagent/Tool/Approval/Artifact 卡片、恢复与审计入口；Task/Run/Artifact 的产品 API 事实来源 |
| `zmzai-cloud` | 统一产品入口、导航、项目和成果的产品级承载；与 Agent 工作台的入口整合 |
| `zmzai-sandbox` | 隔离执行、浏览器/代码/文件操作边界、执行产物回传和资源限制 |
| `zmzai-relay` | 模型目录、路由、流式调用、可靠性、额度与成本信息 |
| `zmzai-db` | 共享 schema 和类型的事实来源：Workspace、Project、Task/Run、ContextItem、Artifact、Automation、ConnectorBinding、成员和权限引用；不拥有运行时状态机 |
| `zmzai-auth` | 登录、SSO、用户身份和身份会话的事实来源；不拥有 Project/Task 业务权限判定 |
| `zmzai-theme` | 对话卡片、计划卡、执行卡、Subagent 卡、Tool 摘要、Approval、成果卡和工作区基础组件；不持有业务状态 |
| `muzhi` | 长期知识沉淀和成果进入知识系统的接口，不成为单次任务的主 UI |
| `zmzai-workos` | 暂不作为独立主线；后续可复用 Project、Task、Artifact 和自动化能力 |

事实来源约束：

- 身份与登录态以 `zmzai-auth` 为准。
- 共享数据结构以 `zmzai-db` 为准。
- Task/Run 状态、事件顺序、审批和恢复语义以 `zmzai-agent` 为准。
- 沙箱执行结果和资源限制以 `zmzai-sandbox` 为准。
- 模型目录、路由和额度以 `zmzai-relay` 为准。
- 页面视觉组件以 `zmzai-theme` 为准；Cloud 只负责产品级入口和组合，不复制 Agent 状态模型。

职责按维度进一步固定：

| 维度 | 唯一事实来源 | 其他仓库的边界 |
| --- | --- | --- |
| 身份、登录会话 | `zmzai-auth` | Agent 只消费已验证的 user/session identity |
| 共享 schema、类型和迁移定义 | `zmzai-db` | Agent 的运行时模型必须兼容并通过此包发布的契约 |
| Project 角色和业务权限评估 | `zmzai-agent` | Auth 提供身份；Cloud 不复制判定；DB 提供角色数据结构 |
| ApprovalPolicy 评估与 ApprovalGrant | `zmzai-agent` | Sandbox 只执行已批准的内部请求；Relay 不决定业务权限 |
| Task/Run/Subagent/ToolCall 状态和 API | `zmzai-agent` | Cloud 只组合入口；Sandbox/Relay 返回内部执行结果 |
| Artifact 元数据、下载授权和生命周期 | `zmzai-agent` | Sandbox 提供受限文件读取；Cloud 通过 Agent API 访问 |
| Sandbox 执行状态和资源限制 | `zmzai-sandbox` | Agent 负责编排和映射为用户事件，不绕过 Sandbox 限制 |
| 模型目录、路由和额度 | `zmzai-relay` | Agent 只选择和展示 Relay 返回的可用能力 |
| 视觉组件和无状态投影 | `zmzai-theme` | 不保存业务状态、不发起权限判定 |

## 9. P0 交付切线

P0 不是一次交付所有平台页面，而是一个 Chat-first Agent Core 垂直切片，包含五项核心能力：任务状态与恢复、结构化卡片、按需工作区、上下文管理和成果交付。

P0 必须实现的最小范围：

- 一个 Chat-first 任务详情页，覆盖五种核心交互状态及 `paused` / `cancelled` 状态。
- 文本消息、文件输入、一个 Sandbox 执行能力，以及一个 `web_app` Artifact：由 Sandbox 生成的静态 HTML/CSS/JS 目录，Agent 通过受保护的 preview endpoint 提供临时预览，并同时生成可下载的 zip 文件。
- 项目级文件/指令上下文；其他 ContextItem 类型保留接口但不要求全部接入。
- Subagent 只支持同一 Task 内的有限并行委派和汇总，不做用户可编排的 Agent Builder。
- 文件上传和 Sandbox 是 P0 的输入/执行能力；P0 不要求第三方 Connector。ConnectorBinding、浏览器和外部系统授权只完成接口边界，首个真实连接器进入 P1。
- 一个高风险 Approval 流程：执行授权、一次性/任务级授权、拒绝、撤销和恢复。
- 成果卡、下载、继续修改和复制到 Project。

明确后置：完整 Connector 目录、邮件/Slack/Webhook 多触发器、复杂自动化编辑器、多类型成果阅读器、实时多人编辑、完整 Skills 市场、全量开发者控制台。它们属于 P1/P2，不阻塞 P0 Core 的验收。

## 10. P0 验收链路

用一个确定的跨能力任务完整验证：

```text
用户在新对话中描述“读取 sales.csv，生成可预览的网页看板并完成质量检查”
→ Agent 解释目标并给出计划，Task 为 draft
→ 用户上传 CSV，Task 创建 Run-01 并进入 running
→ Agent 读取文件、生成代码，普通 Tool 活动在对话中聚合
→ 执行 Sandbox 命令前进入 waiting_approval，Editor 批准一次执行授权
→ Run-01 在授权预算内继续；必要时派出一个数据校验 Subagent
→ 用户点击暂停，当前 ToolCall 完成后 Run-01 变为 paused
→ 用户继续，系统创建 Run-02，使用最近 durable checkpoint，不重复已完成动作
→ Run-02 的 `qa-check` 脚本返回失败 JSON，Task 进入 failed，保留代码和数据 Artifact
→ 用户选择重试，创建 Run-03；使用新的 idempotencyKey 完成质量检查并进入 succeeded
→ 完成卡展示受保护的网页预览、可下载 zip、质量结果和继续修改入口
→ 用户发送后续修改，Task 保留历史并创建 Run-04
```

P0 必须验证以下可观察结果：

- 轻量任务在首屏只显示对话和结果，不出现空的 Subagent/Tool 面板。
- 多步骤任务显示至少一个计划卡；每个步骤有明确状态，并能跳过或重跑一个已完成/失败步骤。
- 发生委派时显示 Subagent 数量、职责、状态和汇总产出；同类 Tool 调用在对话中聚合为一个摘要。
- `waiting_input` 和 `waiting_approval` 使用不同卡片；前者 Member 可以补充信息，后者只有 `Editor` 或更高角色可以批准。
- 高风险执行显示动作和影响范围；`Editor` 批准后 Run-01 在授权预算内继续，撤销后下一次高风险动作重新等待确认。
- 暂停在当前 ToolCall 完成后生效；继续、重试和后续修改分别创建带 `parentRunId` 的 Run-02/Run-03/Run-04。
- 工具失败时，失败卡显示失败步骤、已保留 Artifact 和恢复动作；检查点和 idempotencyKey 保证已提交副作用不重复。
- 刷新或断线后，客户端先加载快照，再按事件序列重放；同一事件不重复展示，Task/Run 状态不倒退。
- 成功任务至少生成一个可预览或下载的 Artifact，并可从完成卡继续发送修改要求。
- `web_app` 预览只允许任务所属用户/项目成员访问，默认 30 分钟过期；下载 zip 走 Agent 鉴权端点。
- `qa-check` 的固定测试夹具至少检查：HTML 可加载、核心数据指标存在、桌面 1280x800 和移动 390x844 两个视口无溢出；全部通过才允许 Run 进入 `succeeded`。

该验收任务只依赖文件输入和 Sandbox，不依赖第三方 Connector；它同时验证对话、文件上下文、计划、Tool、Approval、暂停/恢复、失败重试、工作区预览和 Artifact 交付，不把平台绑定到研究场景。

## 11. 非目标

P0 不包含：

- 完整 Agent Builder 或复杂可视化工作流编辑器。
- 音乐、视频、3D 等独立创作产品线。
- 以研究场景硬编码平台信息架构。
- 默认展开完整模型思考过程或原始工具日志。
- 为每种任务建立独立的产品页面和独立状态机。
- 复杂多人实时编辑；先支持项目成员、任务分享和可控协作。

## 12. 设计判断

平台的稳定核心不是功能菜单，而是下面这条交互闭环：

```text
对话表达目标
→ 结构化任务执行
→ 可理解的状态与人工介入
→ 按需工作区
→ 可复用的成果交付
→ 项目上下文与自动化沉淀
```

这条闭环允许 ZMZAI 后续接近 Manus 的宽能力，同时保持 ChatGPT / ZCode 式的自然交互，不把用户暴露在内部运行时结构中。
