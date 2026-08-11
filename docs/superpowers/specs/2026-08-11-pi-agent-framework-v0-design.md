# PI Agent Framework v0 — 设计规格

> 状态：待评审（2026-08-11）。
> 目标：以 `@earendil-works/pi-agent-core`（下称 **PI**）为执行内核，实现一套 OpenCode 式 Agent 框架（下称 **FW**）。第一个消费者是 `a.zmzai.cloud`（本仓库），框架成熟后抽为独立包。
> 定位：FW 拥有数据模型、事件协议、权限引擎、Agent 注册表；PI 拥有循环、流式、工具执行、上下文管理、compaction。

## 0. 设计原则

1. **协议优先**：先冻结 Session / Message / Part / 事件的 wire 格式（§2、§4），所有客户端（Web 工作台、未来 TUI、第三方 SDK）都只依赖协议，不依赖实现。
2. **云原生第一公民**：多用户、Mongo 持久化、租约恢复是默认形态；本地 JSONL 后端（PI 自带 `harness/session`）作为零依赖演示模式，两者实现同一 `SessionStore` 接口。
3. **单一权限插入点**：所有危险操作的审批只发生在 PI 的 `beforeToolCall` 钩子（§5.4）。工具实现内部不再各自 stage 提案（现有 `exec-tool-broker` / `build-tool-broker` 的提案逻辑上收）。
4. **mode 不存在**：plan/build 切换被 Agent 预设 + permission ruleset 取代（§6）。OpenCode 源码已验证其 plan/build 同理（`edit: deny` + 不同 prompt）。
5. **不引入 Effect / Drizzle / Bun**：普通 async/await + zod。持久层沿用 Mongo（云）或 PI JSONL（本地）。

## 1. 包结构

```
zmzai-agent/framework/           # v0 在本仓库孵化，import 路径 @/framework/*
├── core/
│   ├── session/                 # Session/Message/Part 模型 + SessionStore 接口
│   │   ├── types.ts             #   wire 类型（§2）
│   │   ├── store.ts             #   SessionStore 接口（§3.1）
│   │   └── mongo-store.ts       #   Mongo 实现（云默认）
│   ├── events/
│   │   ├── bus.ts               #   类型化事件总线（§4.1）
│   │   ├── manifest.ts          #   全部事件类型 + zod schema（§4.2）
│   │   └── sse.ts               #   SSE 桥：bus → text/event-stream（§4.3）
│   ├── permission/
│   │   ├── engine.ts            #   ruleset 求值 + ask Deferred（§5.2、§5.3）
│   │   └── ruleset.ts           #   Rule/Ruleset DSL + fromConfig（§5.1）
│   ├── agent/
│   │   ├── registry.ts          #   Agent 预设 + 自定义 agent 加载（§6）
│   │   └── presets/             #   default.ts / readonly.ts（§6.2）
│   ├── tools/
│   │   ├── adapter.ts           #   FW Tool.Def → PI AgentTool 适配（§7.1）
│   │   ├── builtins/            #   read/write/edit/bash 包装 PI harness + glob/grep/todo/webfetch 自研（§7.2）
│   │   └── task.ts              #   子代理工具（§6.4）
│   └── runtime/
│       ├── runner.ts            #   SessionRunner：一次 prompt 的完整生命周期（§8）
│       └── pi-bridge.ts         #   PI 事件 → FW 事件翻译（§8.2）
└── server/                      # HTTP 路由（v0 直接挂在 Next.js App Router 下，§9）
```

## 2. 数据模型（wire 格式）

字段命名对齐 OpenCode `packages/schema/src/v1/session.ts`，但只做云场景需要的子集。所有 ID 带前缀：`ses_` / `msg_` / `prt_` / `per_` / `run_`（run 沿用现有 TaskRun id）。

### 2.1 Session

```ts
type SessionInfo = {
  id: string;                    // ses_...
  workspaceId: string;
  userId: string;
  parentId?: string;             // 子代理会话（task 工具创建）
  title: string;                 // 初始为首条 prompt 截断；异步由便宜模型生成后 session.updated 覆盖（§13.2）
  agent: string;                 // 当前 primary agent 名（预设，见 §6）
  model: { providerId: string; modelId: string };
  permission: Ruleset;           // 会话级规则（子代理会话在此烙印自身规则）
  queuedPrompts: { text: string; agent?: string; enqueuedAt: string }[];  // 运行中输入排队（§13.3）
  revert?: { messageId: string; snapshotRevisionId: string };  // 预留
  time: { created: string; updated: string; archived?: string };
};
```

### 2.2 Message

```ts
type MessageInfo =
  | { id: string; sessionId: string; role: "user";
      agent: string; model: { providerId: string; modelId: string };
      time: { created: string } }
  | { id: string; sessionId: string; role: "assistant";
      parentId: string;          // 触发它的 user message
      agent: string; model: { providerId: string; modelId: string };
      error?: { name: string; message: string };   // APIError/AbortedError/ContextOverflowError/...
      tokens?: { input: number; output: number };
      time: { created: string; completed?: string } };
```

### 2.3 Part（消息由 Part 数组组成，渲染与持久化的最小单元）

```ts
type Part = { id: string; sessionId: string; messageId: string } & (
  | { type: "text"; text: string; synthetic?: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool"; callId: string; tool: string; state: ToolState }
  | { type: "step-start" }                       // 一个 LLM 调用边界
  | { type: "step-finish"; tokens?: {...} }
  | { type: "subtask"; prompt: string; description: string; agent: string; childSessionId: string }
  | { type: "file"; mime: string; filename: string; url: string }   // 产物引用（GridFS 下载/预览 URL）
  | { type: "compaction"; summary: string }
);

type ToolState =
  | { status: "pending";   input: unknown }
  | { status: "running";   input: unknown; title?: string; time: { start: string } }
  | { status: "completed"; input: unknown; output: string; title: string;
      metadata?: Record<string, unknown>;        // diff、exitCode、artifacts、truncated...
      time: { start: string; end: string } }
  | { status: "error";     input: unknown; error: string; time: { start: string; end: string } };
```

**与现状的映射**：现有 `task-event-projection.ts` 拼出的 `ToolNode`/`CanvasArtifact` 被 Part 取代；`binary_file` artifact → `file` part（`metadata.artifacts` 仍在 tool part 上保留清单）；`execution_output` → bash tool part 的 `output`。前端不再手写投影——渲染 = 遍历 parts。

## 3. 持久层

### 3.1 SessionStore 接口

```ts
interface SessionStore {
  createSession(info: SessionInfo): Promise<void>;
  getSession(id: string): Promise<SessionInfo | null>;
  updateSession(id: string, patch: Partial<SessionInfo>): Promise<void>;
  listSessions(filter: { userId: string; workspaceId?: string }): Promise<SessionInfo[]>;
  appendMessage(info: MessageInfo): Promise<void>;
  appendPart(part: Part): Promise<void>;
  updatePart(part: Part): Promise<void>;              // tool state 流转、text 定稿
  getMessages(sessionId: string): Promise<{ info: MessageInfo; parts: Part[] }[]>;
}
```

- **Mongo 实现**（默认）：`fw_sessions` / `fw_messages` / `fw_parts` 三个 collection，`(sessionId, id)` 唯一索引。事件流（§4）写入现有 `TaskEvent` 风格的 `fw_events` collection（`(sessionId, seq)` 唯一索引），与现有审计/回放能力兼容。
- **JSONL 实现**（演示/本地模式）：薄包装 PI `harness/session`，`FilePart` 等非 LLM part 走 `appendCustomEntry("fw.part", part)`。
- 现有 `TaskRun`/`TaskEvent`/`ChangeProposal`/`ExecutionProposal`/`ExecutionGrant` 模型在迁移期保留只读（历史审计页继续可用），新会话只写 FW 模型。

### 3.2 多进程并发

沿用现有租约模式：SessionRunner 启动时 `leaseOwner/leaseExpiresAt` 写在 session 文档上，`lib/lease-recovery.ts` 泛化为 FW session 复用。事件 `seq` 由 Mongo 原子自增分配（与现有一致）。

## 4. 事件协议

### 4.1 总线

```ts
interface EventBus {
  publish(sessionId: string, event: FrameworkEvent): Promise<void>;  // 持久化 fw_events + 推送内存订阅者
  subscribe(sessionId: string, sinceSeq?: number): AsyncIterable<FrameworkEvent>;  // Mongo 轮询（1s，沿用现有 SSE 路由模式）
}
```

### 4.2 事件清单（v0 冻结）

| 事件 | data | 说明 |
|---|---|---|
| `session.updated` | `SessionInfo` | title/agent/permission/归档变化 |
| `session.status` | `{ status: "idle"\|"running"\|"waiting_permission" }` | 对应现有 run 状态机，简化为三态 + error 事件 |
| `session.error` | `{ name, message }` | 致命错误（对应现有 run.failed） |
| `message.updated` | `MessageInfo` | user/assistant 消息创建与完成 |
| `message.part.updated` | `Part` | part 全量快照（tool state 流转、text 定稿） |
| `message.part.delta` | `{ messageId, partId, field: "text", delta }` | 流式增量（渲染走这里，快照用于恢复） |
| `permission.asked` | `PermissionRequest`（§5.3） | 审批请求（内联渲染为审批卡片） |
| `permission.replied` | `{ id, reply }` | 审批决议 |
| `todo.updated` | `{ todos: { content, status, priority }[] }` | todo 工具的投影（checklist UI 数据源） |
| `file.edited` | `{ path, revisionId, diff }` | write/edit 落库后发布（右侧 diff 面板 + revert） |
| `artifact.created` | `{ artifactId, path, bytes, contentType, downloadUrl, previewUrl? }` | 沙箱产物回传（含 HTML previewUrl，§10） |

事件持久化全部进 `fw_events`（含 delta——沿用现有 "delta 攒批 ~2KiB" 策略），支持断线 `sinceSeq` 重放，与现有 `/api/runs/:id/events` 行为一致。

### 4.3 SSE 桥

`GET /api/sessions/:id/events?since=<seq>` → `text/event-stream`。事件名 = 事件 type，data = JSON。session 进入 idle 且无活跃 runner 时流关闭（沿用现有终态关流逻辑）。

## 5. 权限引擎

### 5.1 Ruleset DSL

```ts
type Action = "allow" | "deny" | "ask";
type Rule = { permission: string; pattern: string; action: Action };
type Ruleset = Rule[];

// 配置语法（opencode.json 同款）：
// "ask" | { [permission]: Action | { [pattern]: Action } }
```

- permission key：`read, edit（覆盖 write/edit/apply_patch）, bash, glob, grep, list, webfetch, task, todo, external_directory` + 未来 MCP `server_*`。
- pattern：glob，bash 匹配规范化命令串（`"git push *": "deny"`），edit/read 匹配路径。
- 求值：**最后匹配的规则生效**；无匹配默认 `ask`。bash 命令先解析重定向/管道为子命令逐段求值（v0 可退化为整串匹配，标记为已知简化）。

### 5.2 引擎

```ts
class PermissionEngine {
  constructor(private rulesets: Ruleset[]) {}   // 求值顺序：内置默认 → agent 预设 → 会话级（后加优先）
  evaluate(permission: string, pattern: string): Action;                       // 同步
  ask(ctx: { sessionId: string; tool?: { messageId: string; callId: string };
           permission: string; patterns: string[]; always?: string[]; metadata?: unknown }): Promise<Reply>;
  reply(requestId: string, reply: Reply, feedback?: string): void;
}
type Reply = "once" | "always" | "reject";
```

`ask()`：逐 pattern 先 `evaluate`（全 allow 则短路）→ 否则发 `permission.asked` 并挂起 Deferred → `reply()` 解决。`always` 把 `{permission, pattern, allow}` 推入会话级 ruleset（持久化在 `SessionInfo.permission`），并自动解决同 session 内已被覆盖的其他 pending 请求。`reject` 附带用户反馈作为 `CorrectedError` 抛回模型。

### 5.3 PermissionRequest

```ts
type PermissionRequest = {
  id: string;                    // per_...
  sessionId: string;
  permission: string;            // "bash" | "edit" | ...
  patterns: string[];            // 本次请求的具体对象（命令串、文件路径）
  metadata?: unknown;            // bash: {command}; edit: {diff}; task: {subagent}
  always: string[];              // 批准 "always" 时固化的 patterns
  tool?: { messageId: string; callId: string };
};
```

### 5.4 唯一插入点：beforeToolCall

SessionRunner 创建 PI Agent 时挂：

```ts
agent.beforeToolCall = async ({ toolCall, args, context }) => {
  const req = toolPermissionRequest(toolCall.name, args);       // 工具声明的权限映射（§7.1）
  const reply = await permission.ask(req);                      // allow 时内部短路，不产生事件
  if (reply === "reject") return { block: true, reason: feedback ?? "用户拒绝", terminate: false };
  return undefined;                                             // once/always 放行
};
```

- **grant 迁移**：现有 `ExecutionGrant`（20 条/10 分钟）改为引擎内置的**配额规则**：`always` 决议可附带 `{ budget: { commands: 20, wallTimeMs: 600000 } }`，引擎在会话级规则上记账，耗尽自动回落 `ask`。行为与现状一致，实现从 exec-tool-broker 上收。
- **waiting_permission 三态**：`permission.asked` 时 session.status = `waiting_permission`，前端内联渲染审批卡；run 不再为此停留（事件流天然支持异步）。
- **进程重启**：pending Deferred 丢失 → 恢复时以 `reject`（reason: "服务重启，请重试"）解决，与现有 exec 恢复语义对齐。

### 5.5 内置默认（对齐 OpenCode `agent/agent.ts`）

```
*: allow
external_directory: { "*": ask }        # 云场景基本不触发（workspace 虚拟文件系统）
read: { "*": allow, "*.env": ask, "*.env.*": ask }
bash: ask                                # 云上 exec 默认需一次授权（= 现状 grant 首批准）
edit: allow                              # auto 档：直写 + file.edited 事件 + revert
```

"监督/自动/全自动"不再是产品档位，而是三个内置 agent 预设的 ruleset 差异（§6.2）。

## 6. Agent 注册表

### 6.1 Agent 定义

```ts
type AgentInfo = {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  model?: { providerId: string; modelId: string };
  temperature?: number; topP?: number;
  prompt?: string;                       // system prompt 覆盖
  steps?: number;                        // 最大 agentic 轮次（→ PI shouldStopAfterTurn）
  permission: Ruleset;
  color?: string;
};
```

### 6.2 内置预设（替代 plan/build toggle）

| name | mode | permission delta | prompt |
|---|---|---|---|
| `default` | primary | `{}`（继承默认，edit allow / bash ask） | 现有 build 版 system prompt 的"主动交付"段（`agent-runtime.ts:68`） |
| `readonly` | primary | `{ edit: deny, bash: deny, task: deny }` | 现有 plan prompt |
| `explore` | subagent | `{ *: deny, read/glob/grep/list/bash(只读白名单): allow }` | 代码库探索专用 prompt |
| `general` | subagent | 默认规则，无特殊 | 通用子任务 |

用户感知：没有切换；`readonly` 仅以"@readonly 分析一下…"或会话下拉的形式存在。旧 `TaskRun.mode` 字段停止写入，审计页归档。

### 6.3 自定义 Agent（v0 简化）

`.zmzai/agents/*.md`（workspace 文件内）YAML frontmatter：`description`（必填）、`mode`、`model`、`temperature`、`steps`、`permission`、正文 = system prompt。registry 在 session 创建时加载合并（内置 → workspace 自定义，同名覆盖）。

### 6.4 子代理：task 工具

```
task({ description, prompt, subagent_type }):
  1. 深度检查（parentId 链 < subagent_depth=1）
  2. permission.ask({ permission: "task", patterns: [subagent_type], always: ["*"] })
  3. 创建子 SessionInfo { parentId, workspaceId: 父会话的 workspaceId（§13.1 强绑继承）, agent: subagent_type, permission: 合并(父会话规则, 子agent规则) }
  4. 新 SessionRunner 跑子会话（同进程）
  5. 父 tool part metadata 记录 childSessionId（前端可展开子会话转录）
  6. 结果渲染回父上下文：<task id="ses_…" state="completed">…</task>
```

被 ruleset deny 的 subagent 从 task 工具 description 中剔除（模型不可见）。

## 7. 工具系统

### 7.1 定义与适配

```ts
type ToolDef = {
  id: string;
  description: string;
  parameters: ZodType;                                  // 框架内统一 zod；适配层转 pi-ai Type
  permission: (args) => { permission: string; patterns: string[]; always?: string[]; metadata?: unknown };
  execute(args, ctx: ToolContext): Promise<{ title: string; output: string; metadata?: Record<string, unknown> }>;
};
type ToolContext = {
  sessionId: string; agent: string; abort: AbortSignal;
  ask: PermissionEngine["ask"];                          // 工具内升级权限（少用；首选声明式 permission）
  setMetadata(patch): Promise<void>;                     // 更新运行中 tool part 的 title/metadata
  bus: EventBus;
};
```

`adapter.ts`：zod → JSON Schema → pi-ai `Type`；`execute` 包一层输出截断（沿用现有 4KiB 摘要 + 全量入 metadata 策略）；`beforeToolCall` 统一过权限（§5.4）。

### 7.2 内置工具清单

| 工具 | 来源 | 说明 |
|---|---|---|
| read / write / edit | 包装 PI `harness/tools` | 云后端：操作 WorkspaceFile（Mongo 虚拟 FS）；本地后端：真实 FS。write/edit 落库后发 `file.edited`（含 unified diff + revisionId，复用 `lib/unified-diff.ts` 与 `lib/proposals.ts` 的 diff/shadow 逻辑） |
| bash | PI harness 包装 → 沙箱 | `runSandboxCommandAndStream`（现有 `lib/sandbox-execution.ts`）直接复用；产物回传、GridFS、downloadUrl 全保留 |
| glob / grep | 自研（~100 行） | 云：WorkspaceFile 正则/路径匹配；本地：ripgrep |
| todo | 自研（~80 行） | 写 session 级 todo 状态 → `todo.updated` 事件；UI checklist 数据源 |
| webfetch | 自研 | 白名单域 + 大小上限；v0 可标记 experimental |
| task | §6.4 | 子代理 |

现有 `list/read/search`（read-only-tool-broker）并入 read/glob/grep；现有 write/edit 提案 staging 在 auto 预设下被 `edit: allow` 直写取代，supervised（=readonly 反向预设）由权限引擎统一转 ask——**broker 层的提案代码在 FW 切换后删除**。

## 8. SessionRunner（PI 适配层）

### 8.1 职责

一次 `prompt` 的完整生命周期：建/复用 PI Agent → 订阅 PI 事件翻译为 FW 事件（持久化 + 推送）→ 驱动 Part 状态机 → 终局结算（tokens、error、status）。

```ts
class SessionRunner {
  constructor(store, bus, permission, registry, deps /* sandboxClient, relayStream */) {}
  async prompt(sessionId: string, input: { text: string; agent?: string; model?: {...} }): Promise<void>;
  // runner 活跃时 prompt 不直接执行，push 进 SessionInfo.queuedPrompts；
  // 当前 run 终局结算后自动 dequeue 下一条继续（§13.3）。
  async replyPermission(sessionId: string, requestId: string, reply: Reply, feedback?: string): Promise<void>;
  async abort(sessionId: string): Promise<void>;   // abort 当前 run 并清空 queuedPrompts
}
```

进程内 `Map<sessionId, { agent: PI.Agent; engine: PermissionEngine }>`（沿用现有 `globalThis` 单例模式防 HMR 重复）；steering/follow-up 队列后续支持（PI 原生有）。

### 8.2 PI 事件 → FW 事件翻译（pi-bridge）

| PI 事件 | FW 动作 |
|---|---|
| `message_start`(user) | appendMessage(user info) + `message.updated` |
| `message_start`(assistant) | appendMessage(assistant) + `step-start` part |
| `message_update.text_delta` | `message.part.delta`（攒批 2KiB，沿用现有策略） |
| `message_update` reasoning | 同上，`reasoning` part |
| `message_end`(assistant) | text part 定稿 `message.part.updated` + `step-finish`(tokens) |
| `tool_execution_start` | tool part `pending→running`（`message.part.updated`） |
| `tool_execution_update` | tool part running（title/metadata 增量） |
| `tool_execution_end` | tool part `completed/error`（output、metadata；bash 附 artifacts → 另发 `artifact.created`） |
| `agent_end` / error | assistant info 完成（`message.updated`）+ `session.status: idle` 或 `session.error` |
| `shouldStopAfterTurn` | steps 预算检查（AgentInfo.steps，默认 12，沿用现有 budget） |

**convertToLlm**：v0 直接用 PI 默认（FW 的 parts 不落 PI 上下文；PI 的 `AgentMessage[]` 是唯一的模型上下文来源，FW store 是对外的展示/回放投影）。跨进程恢复 = 从 FW store 重建 PI messages（v0 沿用现有 `continuation-context.ts` 逻辑：session 内按序回放到新 Agent 实例）。

### 8.3 Compaction

PI `harness/compaction` 挂 `shouldStopAfterTurn`（tokens 阈值）→ 生成 `compaction` part。v0 只做自动阈值版；branch-summarization 后置。

## 9. HTTP 接口（v0 挂 Next.js App Router）

```
POST   /api/sessions                          创建（workspaceId, agent?, model?）
GET    /api/sessions?workspaceId=             列表
GET    /api/sessions/:id                      详情 + messages+parts
POST   /api/sessions/:id/prompt               { text, agent? } → 202（异步，事件驱动）
POST   /api/sessions/:id/abort
POST   /api/sessions/:id/permissions/:pid     { reply: once|always|reject, feedback? }
GET    /api/sessions/:id/events?since=        SSE
GET    /api/agents                            注册表（前端渲染 @ 提及与预设）
GET    /api/models                            沿用现有
```

产物下载/预览沿用现有 `/api/runs/:runId/artifacts/...`（v0 期间 runId=sessionId 的兼容映射，迁移后改 `/api/sessions/:id/artifacts/...`）。认证、幂等（idempotency-key）、audit 页全部沿用现有设施。

## 10. 对 a.zmzai.cloud 产品的落地（吃自己狗粮）

切换顺序（每步独立可上，详见 §11）：

1. **双写期**：FW runner 上线，新会话写 FW 模型；旧 TaskRun 会话只读可回放。前端新增 `/s2/[sessionId]` 路由渲染 FW 协议（**渲染 = 遍历 parts**，ToolCard/审批卡/todo checklist 都是 part 的组件），旧 `/s/` 保留。
2. **交互切换**：新协议页面成为默认。plan/build toggle 消失（agent 预设取代）；审批从右侧画布改为对话流内联卡（`permission.asked` part 渲染）；todo checklist 置顶；产物 `file` part 内联卡片（HTML 产物给 previewUrl iframe 预览——沙箱侧新增 `/preview` 端点，以正确 Content-Type 输出而非 attachment）。
3. **旧协议下线**：历史数据归档，broker 提案代码、mode 字段、旧投影（`task-event-projection.ts`）删除。

## 11. 实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 骨架** | §2 类型 + Mongo store + 事件总线/SSE + permission 引擎（含单测：last-match-wins、always 固化、reject 反馈） | 引擎测试全绿；事件可写可回放 |
| **M2 Runner** | PI 适配层 + 工具适配（read/write/edit/bash/glob/grep/todo）+ presets + HTTP 路由 | curl 创建 session → prompt → SSE 收全事件流；bash 审批 once/always/reject 全路径 |
| **M3 产品切换** | 新前端（parts 渲染、内联审批、todo、产物预览）+ 双写切换 | a.zmzai.cloud 默认无 toggle，自动执行全链路（写文件→沙箱跑→产物下载/预览） |
| **M4 框架化** | task 子代理、自定义 agent md、webfetch、compaction 接线、JSONL 本地后端 | `.zmzai/agents/*.md` 生效；`FW_MODE=local` 无 Mongo 可跑演示 |
| **M5 抽包** | 独立 npm 包 + OpenAPI + 最小 TUI/CLI | 第三方可 `createServer()` 起框架 |

M1–M3 是产品价值闭环（= 此前讨论的"取消 toggle + 自动执行 + 内联审批 + 作品预览"），M4–M5 是框架价值闭环。

## 11.1 实现状态（2026-08-11 更新）

- **M1–M3 完成并已上生产**：commit `ea5f65d` 部署 a.zmzai.cloud，PPT 垂直场景端到端验收通过（写脚本→沙箱→10 页 pptx 下载可打开）。旧 plan/build 协议已下线。
- **M4 完成（代码级）**：
  - `task` 子代理：`framework/core/tools/task.ts` + runner `spawnSubagent`——深度上限（subagentDepth=1，parentId 链）、权限合并（父会话 ruleset 烙印到子会话）、子会话用独立 SessionRunner 跑、结论回传父上下文、subtask part 链接父子。
  - 自定义 agent：`framework/core/agent/loader.ts` 解析 `.zmzai/agents/*.md`（零依赖 frontmatter 解析器，支持 description/mode/model/temperature/top_p/steps/hidden/permission），runner 经 `registry.derive()` 注入 workspace agents（不动共享单例）。
  - compaction：`framework/core/runtime/compaction.ts`——`transformContext` 检测超长（chars/4 估算 + contextWindow 阈值）→ relay 模型生成摘要 → 旧历史替换为摘要 + 保留尾部 8 条，发 `compaction` part；摘要失败降级全量上下文。`streamOneText` 驱动 AssistantMessageEventStream.result() 取全文（也供 title 生成复用）。
  - JSONL 本地后端：`framework/core/session/jsonl-store.ts`（SessionStore 文件实现， sessions/messages/parts 各一个 JSON 目录），`FW_MODE=local FW_DATA_DIR=...` 时 `defaultStore` 切换为 JSONL（零 Mongo 演示）。
- 113 测试绿、typecheck/lint/build 通过。
- **遗留**：① workspace facade 的本地 FS 实现（JSONL 后端的 workspace 仍走 Mongo，FW_MODE=local 目前只覆盖 session 存储）；② title 异步生成（streamOneText 已就绪，未接 runner）；③ 子代理嵌套完成的端到端单测（单进程双 PI 循环时序脆弱，生产已用真模型验证）。

- **M5 抽包完成（2026-08-11，代码级）**：`packages/agent-framework`（@zmzai/agent-framework）独立 npm 包。核心（session/events/permission/agent/tools/runtime）全部适配器化——ModelProvider/SandboxExecutor/LeaseStore/EventLog/WorkspaceFiles 五个注入接口，包带参考实现（JSONL store、FS workspace、子进程 sandbox、OpenAI-compatible provider、内存 event log）。`createServer(deps)` 组装；`zmzai-agent serve/run` CLI（bin）；openapi.yaml 契约；examples/standalone.mjs 演示。产品侧 `framework/` 变为薄兼容层（mongo-store/mongo-event-log/mongo-workspace + 从包 re-export），产品组装在 framework/server/context.ts，路由零改动。tsconfig/vitest alias 指向包源码。包独立 build 产出 dist（NodeNext + .js 扩展），第三方 `createServer()` 验证通过，CLI serve 建 session 201 验证通过。191 测试绿（包 77 + 产品 114）+ typecheck + next build 全过。**未做**：发布公共 npm、完整 TUI、webfetch 实现。

## 12. 非目标（v0）

- 不做 LSP、formatter、MCP、plugin npm 安装器（M5 后）。
- 不做 worktree/git snapshot 级 revert（用 Workspace revision revert 顶替）。
- 不做多用户实时协作、session 分享页。
- 不兼容 OpenCode 的 SQLite schema / OpenAPI（只借鉴协议形状，不追求 wire 兼容——除非未来要复用其 TUI，届时再加适配层）。
- bash 管道/重定向的细粒度权限求值（v0 整串匹配，已知简化）。

## 13. 已锁定决策（2026-08-11 用户拍板）

1. **session ↔ workspace 强绑**：session 创建时绑定单一 workspace，不可变更；子代理（task 工具）创建的子会话强制继承父会话的 workspaceId。
2. **title 用便宜模型异步生成**：session 创建后首个 prompt 触发后台 title 生成（走 relay 的 cheap model，复用现有 `lib/relay-agent-models.ts` 目录），完成后发 `session.updated` 事件推送给前端；生成失败则回退为首条 prompt 截断。生成期间不阻塞 runner。
3. **运行中输入先做排队**：`POST /sessions/:id/prompt` 在 runner 活跃时进入会话级 FIFO 队列（持久化在 session 文档的 `queuedPrompts` 字段），当前 run 终局结算后由 runner 自动取出下一条继续；UI 显示"已排队 N 条"。PI 的 steering/follow-up 队列机制后置（M4 评估升级为真正的运行中 steering）。
