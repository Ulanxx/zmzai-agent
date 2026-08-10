# a.zmzai.cloud v1 任务计划与执行计划

> 对应规格：[Agent Runtime v1 最终规格](../specs/2026-08-10-agent-runtime-v1-pi-design.md)
>
> 仓库：`zmzai-agent`。线上产品域名：`a.zmzai.cloud`。
>
> 本文是实施顺序，不改变最终规格中已锁定的产品和安全边界。

## 1. 已验证的起点

截至 2026-08-10，仓库是 Next.js 15.5.21 的页面骨架：

| 现状 | 证据 | 结论 |
| --- | --- | --- |
| 技术栈 | `package.json` | 只有 Next.js、React、TypeScript 与 Tailwind；尚未引入 Agent、Mongo 或测试依赖。 |
| 产品页面 | `app/page.tsx` | 当前只展示“Agent 使”建设中页面。 |
| 最终架构 | `docs/superpowers/specs/2026-08-10-agent-runtime-v1-pi-design.md` | Pi 只作为循环；模型经 Relay，代码经 Sandbox。 |

因此 v1 采用 Next.js 的 Node Runtime Route Handler 作为 API 入口，按领域拆分服务模块。不要在初期另起一个第二后端进程。SSE 长连接、运行队列和恢复机制由应用服务与 MongoDB 的租约记录实现。

## 2. 范围、边界与完成定义

### v1 必须完成

1. 已登录用户可创建、查看和管理自己的文本 Workspace。
2. 用户可在 Plan 或 Build 模式创建 Task Run，并经 `m.zmzai.cloud` Relay 调用所选模型。
3. Agent 可以使用 `list`、`read`、`search`；Build 模式可生成 `write`、`edit` 提案。
4. 用户能查看 diff、批准或拒绝提案，并在版本冲突时得到确定性提示。
5. 代码只在获得单次批准后，通过 `z.zmzai.cloud` Sandbox 临时快照执行。
6. 用户能看到可重连 SSE 事件流，可取消任务，并在服务重启后不重复副作用。

### v1 明确不做

- `webfetch`、浏览器自动化、MCP Connector、OAuth Connector。
- 定时任务、Webhook、多人协作、共享和计费管理 UI。
- 用户填写上游模型 API Key、直连 OpenAI、直连 Sandbox Key。
- 子 Agent、自动派生任务、长期记忆和 Skills 市场。
- 二进制 Workspace 文件、大文件和对象存储。

### 发布完成定义

生产环境中，一个已登录用户可完成“创建 Workspace -> Plan 读取 -> Build 生成 diff -> 批准变更 -> 批准 Sandbox 执行 -> 查看结果”的完整流程；在断线、取消、余额不足和一次服务重启时均保留正确的持久化状态。

## 3. 实施原则

- **先固定跨产品契约，再写 Agent Loop。** Relay 与 Sandbox 返回结构不稳定时，PI 集成没有可靠基础。
- **先只读，再写入，再执行。** 文件变更和代码执行都是高副作用能力，不能与聊天界面并行“边做边定”。
- **先可审计，再自动恢复。** 每个状态转换、工具调用和审批先持久化，SSE 只是状态投影。
- **模型输出永远不拥有权限。** Tool Broker 而不是 Prompt 决定工具、预算、路径和审批。
- **每一个有副作用的请求都幂等。** 前端重试、网络重放和服务重启不能生成第二次写入或第二次 Sandbox 运行。

## 4. 关键依赖与责任归属

| 依赖 | 责任方 | Agent 所需内容 | 不能接受的替代方案 |
| --- | --- | --- | --- |
| ZMZAI Auth | 平台 Auth | 已验证 session 中的稳定 `userId` | 浏览器把用户 ID 当可信输入。 |
| Relay | `m.zmzai.cloud` | 服务认证的内部 Agent Completion 接口、流式/非流式响应、模型目录、用量与稳定错误码 | Agent 直连 Provider 或让用户提交 API Key。 |
| 余额策略 | `m.zmzai.cloud` | 余额不足时返回可识别的 `402` / 错误码 | Agent 自行估算余额。 |
| Sandbox | `z.zmzai.cloud` | 临时文件快照执行、状态查询、SSE/轮询、取消、产物引用 | Agent 容器直接访问 Docker 或宿主机。 |
| MongoDB | `zmzai-agent` | 高可用连接、备份、最小权限应用账号 | PI JSONL 或内存成为持久化来源。 |
| 部署 | 香港服务器 + self-hosted runner | 环境变量、健康检查、滚动/可回退发布 | 把服务密钥写入 Git 或浏览器。 |

### 上线前必须冻结的接口

以下三项是 P0 阻塞项，未冻结前不开始真正的多轮 Agent 调用：

1. Relay 内部身份形式：服务凭据、`userId`、`taskRunId`、`model` 的请求字段和签名/轮换方式。
2. Relay 错误映射：余额不足、模型不可用、限流、超时、取消的稳定错误码与是否已计费。
3. Sandbox 快照契约：创建请求、状态机、取消语义、输出大小限制、产物 URL/ID 的保存期限。

## 5. 任务计划

### P0：接口与运行基线

| ID | 任务 | 产出 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| A-01 | 冻结 Relay 内部 Agent 契约 | 版本化 JSON Schema、认证说明、错误映射 | Relay 团队 | 可用 curl/集成测试完成一次模型请求，且不需用户 API Key。 |
| A-02 | 冻结 Sandbox 执行契约 | 快照、状态、取消、产物的接口文档与测试样例 | Sandbox 团队 | 对临时快照的创建、完成、失败、取消都有确定性响应。 |
| A-03 | 建立应用配置基线 | 服务端环境变量 Schema、健康检查、日志字段、部署变量清单 | A-01、A-02 | 缺失必需密钥时应用拒绝启动；密钥不进入前端 bundle 或日志。 |
| A-04 | 建立质量基线 | ESLint、单元测试、集成测试、CI 中的 typecheck/build/test | A-03 | PR 和生产部署前自动执行三类检查。 |

### P1：持久化控制面

| ID | 任务 | 产出 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| A-05 | 建立 Auth 与租户隔离中间件 | 当前用户解析、`requireUser`、资源归属校验 | A-03 | 访问另一个用户的任一资源统一得到不泄露存在性的响应。 |
| A-06 | 建立 Mongo 数据模型与索引 | Workspace、File、Revision、Session、Run、Event、Proposal、ToolCall、Idempotency、Lease collection | A-03 | 创建、读取、按用户过滤、版本 compare-and-set、唯一活跃 Run 均有集成测试。 |
| A-07 | 建立 Workspace/Revision API | Workspace CRUD、受限文件读取、Revision 列表、回滚 | A-05、A-06 | 文件路径、大小、总配额、敏感路径和版本回滚均有确定测试。 |
| A-08 | 建立 Task Run/Event Store | Run 状态机、单调序号、幂等键、SSE replay、租约、前端事件 Schema | A-06 | 使用 `Last-Event-ID` 重连不漏事件、不重复副作用；同 Workspace 并发创建被拒绝；事件 Schema 覆盖消息、工具、提案、审批和 Sandbox 生命周期。 |

### P2：只读 Agent

| ID | 任务 | 产出 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| A-09 | 接入精确版本的 PI Core | `@earendil-works/pi-agent-core@0.84.1` 封装层；禁止本地 PI 工具的回归测试 | A-01、A-08 | 运行时只暴露 ZMZAI 注册的工具，PI 内置文件/Shell/网络工具无法被调用。 |
| A-10 | 实现 Relay Model Adapter | 内部 Relay 客户端、流式文本转事件、错误和用量映射、取消 | A-01、A-08 | 所有模型请求含 Run 身份；`402` 变为 `INSUFFICIENT_CREDITS`；取消不继续消费文本。 |
| A-11 | 实现只读 Tool Broker | `list/read/search` Schema、路径与配额校验、结构化结果 | A-06、A-09 | Plan 模式中请求写入或执行被 Broker 拒绝，不依赖模型是否遵守指令。 |
| A-12 | 完成 Plan Agent 工作台 | Workspace 左栏、流式对话中栏、任务/文件画布、模型选择、工具活动摘要、可重连事件视图、取消和画布固定 | A-07 至 A-11 | 用户可完成只读 Plan；刷新页面后从 Run 状态和事件继续看到相同历史；画布完全由持久化数据重建；不展示原始思维链。 |

### P3：Build 提案与版本控制

| ID | 任务 | 产出 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| A-13 | 实现 Proposal 与 Shadow View | 暂存变更、`write/edit` Schema、基于同 Run 的可读 Shadow State | A-08、A-11 | 未批准的写入只对同一 Run 可见；其他 Run 和 Workspace 当前版本不变。 |
| A-14 | 实现审批与 Revision 原子提交 | 批准/拒绝 API、compare-and-set、冲突与 supersede | A-06、A-13 | 重复批准只生效一次；基础版本冲突不写入；拒绝没有状态副作用。 |
| A-15 | 完成 Build/Diff 画布 | Plan/Build 明确选择、Diff 画布、批准/拒绝、冲突、回滚、用户固定画布后的非抢占提示 | A-12 至 A-14 | 用户能审查每个文件变化，批准后生成不可变 Revision，拒绝后 Agent 收到结构化结果；新的提案不会抢占用户已固定的画布。 |

### P4：Sandbox 执行

| ID | 任务 | 产出 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| A-16 | 实现 Sandbox Client | 经服务端凭据调用 Sandbox 的 create/status/cancel/artifact adapter | A-02、A-08 | Agent 进程、浏览器和模型上下文都看不到 Sandbox 服务凭据或 `sandbox_key`。 |
| A-17 | 实现经过审批的 `exec` 工具 | 临时 Revision 快照、单次执行审批、事件转发、产物引用 | A-13、A-14、A-16 | Sandbox 无法访问 Mongo 或权威 Workspace；结果不能直接修改文件。 |
| A-18 | 完成执行结果画布 | 执行审批、实时状态、stdout/stderr、产物链接、取消/失败提示和小屏幕页签适配 | A-12、A-17 | 用户只会看到自己 Run 的结果，取消操作可重复点击且最终状态正确；小屏幕上审批与对应执行范围始终可访问。 |

### P5：恢复、安全与发布

| ID | 任务 | 产出 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| A-19 | 实现 Lease Recovery | 过期租约扫描、工具边界恢复、Sandbox 状态对账、重复调用隔离 | A-08、A-10、A-17 | 在模型流、待审批和 Sandbox 运行三个场景中故意重启服务，均不重复副作用。 |
| A-20 | 安全与审计加固 | 日志脱敏、输入验证、预算限制、审计视图、保留策略 | A-05 至 A-19 | 密钥/令牌不出现在事件和日志中；路径穿越、超限输入、越权访问均被测试阻止。 |
| A-21 | 性能与容量验证 | 任务负载测试、Mongo 索引验证、超时/输出上限验证、告警阈值 | A-19、A-20 | 在目标服务器上稳定运行 3 个并发 Sandbox 关联任务，且控制面不丢事件。 |
| A-22 | 生产发布与回退演练 | Staging 检查表、生产 Smoke Test、版本化发布、回退步骤 | A-21 | 发布后全链路 Smoke Test 通过；可在不丢失 Mongo 状态下回退应用版本。 |

## 6. 执行顺序

```text
A-01 Relay 契约 ─┐
                 ├─> A-03 配置基线 ─> A-04 质量基线
A-02 Sandbox 契约┘                 │
                                   v
                         A-05 Auth ─> A-06 Mongo ─> A-07 Workspace API
                                                   └─> A-08 Run/Event Store
                                                            │
                                                            v
                 A-09 PI ─> A-10 Relay Adapter ─> A-11 Read Broker ─> A-12 Plan 工作台
                                                                         │
                                                                         v
                                      A-13 Shadow Proposal ─> A-14 Approval ─> A-15 Build/Diff 画布
                                                                         │
                              A-16 Sandbox Client ──────────────────────┤
                                                                         v
                                                              A-17 Exec ─> A-18 执行结果画布
                                                                         │
                                                                         v
                                               A-19 Recovery -> A-20 Security -> A-21 Load -> A-22 Release
```

关键路径是 `A-01/A-02 -> A-03 -> A-06 -> A-08 -> A-10 -> A-11 -> A-13 -> A-14 -> A-17 -> A-19 -> A-22`。UI 工作可以在对应后端契约稳定后并行，但不能先于状态语义完成。

## 7. 每个阶段的执行方法

### 阶段 0：先写契约测试

先在 `zmzai-agent` 定义 Adapter 接口和 contract fixture，再分别对接 Relay 与 Sandbox。通过 mock 验证 Agent 侧错误映射后，再接真实服务。这样 `m` 或 `z` 的接口调整只影响各自 Adapter，而不会污染 Task Runtime。

### 阶段 1：先做控制面，不做聊天“假演示”

先完成用户隔离、Mongo Schema、Revision 原子提交、Event Store 与 SSE replay。此阶段页面可以极简，但数据库状态机和幂等规则必须可测试。事件 Schema 必须覆盖消息、工具、提案、审批和 Sandbox 生命周期。任何聊天展示或画布都只能消费持久化事件，不能以浏览器内存作为真相。

### 阶段 2：只读闭环

加入 PI 与 Relay Adapter，只注册 `list/read/search`。完成一个可生产使用的 Plan 闭环：开始任务、显示流式事件、取消、刷新恢复、余额不足提示；实现 Workspace 左栏、对话中栏和任务/文件画布。此阶段不允许 `write/edit/exec`，以便隔离模型接入、事件与授权问题。

### 阶段 3：把“修改”变成可审核提案

只允许 PI 产生候选变更。Broker 生成 diff 和 Shadow View，Task Run 进入 `waiting_approval`。Diff 画布在未固定时自动打开；用户固定其他画布后只接收非抢占提示。批准前绝不能改变 `currentRevisionId`；批准后必须用 compare-and-set 创建新的不可变 Revision。此阶段交付后，Agent 已能安全地“创建和修改应用”。

### 阶段 4：把“执行”变成可撤销的外部作业

`exec` 不接触权威文件系统。Agent 先生成临时快照，用户批准后才调用 Sandbox。Sandbox 状态与产物通过 Adapter 读回并成为 Run Event；取消或服务重启均先对账 Sandbox，再恢复 Agent。

### 阶段 5：用故障演练决定是否上线

在 staging 进行四类强制演练：浏览器断线重连、Relay 余额不足、Sandbox 超时/取消、应用进程重启。只有全部满足“不丢事件、不跨用户、不重复副作用”，才允许发布生产。

## 8. 测试与发布检查表

| 层级 | 必须覆盖的行为 |
| --- | --- |
| 单元测试 | 路径规范化、文件配额、Schema 验证、预算、状态机、工具注册、错误映射、脱敏。 |
| Mongo 集成测试 | 用户隔离、Idempotency、Revision compare-and-set、唯一活跃 Run、事件序号和租约。 |
| Adapter Contract 测试 | Relay 流、402、限流、超时、取消；Sandbox 创建、状态、失败、取消、产物。 |
| 端到端测试 | Plan 读取、Build 提案、批准/拒绝、执行、取消、SSE 断线重连、回滚。 |
| 故障演练 | 服务重启、Sandbox 在途、审批在途、Relay 中断、Mongo 短暂不可用。 |
| 安全测试 | 越权资源 ID、路径穿越、`.env`/`.git`、超限文件、恶意模型工具参数、SSE 订阅越权。 |

生产发布前的最低 Smoke Test：

1. 登录后创建一个 Workspace 和文本文件。
2. 以 Plan 模式请求 Agent 读取该文件，确认模型请求经过 Relay。
3. 以 Build 模式生成一处 `edit` 提案，拒绝一次、批准一次，并确认 Revision 正确。
4. 提交一段安全的脚本，批准 `exec`，确认它只在 Sandbox 中运行并返回结果。
5. 打开第二个浏览器会话或使用另一个用户，确认无法读取第一个用户的 Run、事件、提案和产物。
6. 重启应用服务后读取同一 Run，确认无重复文件版本、无重复 Sandbox 执行。

## 9. 首次开发批次

第一批只执行 `A-01` 到 `A-08`，目标是可验证的控制面，而不是可见的 Agent 聊天效果。

完成第一批后，必须进行一次设计复核，确认：

- Relay 内部身份和计费错误是否符合已冻结契约；
- Mongo 的唯一索引、Revision compare-and-set、事件序列和 Idempotency Key 是否真的原子；
- SSE replay 和租约恢复是否可在测试中复现；
- 当前目录结构是否仍能保持 Tool Broker、PI Adapter 与存储层独立。

复核通过才进入 `A-09` 到 `A-12` 的只读 Agent 闭环。
