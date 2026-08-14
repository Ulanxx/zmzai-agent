# 三方架构比对与优化点

> 对照对象：**zmzai-agent**（本仓）vs **deepseek-harness (dsh)** vs **DeepSeek-Reasonix**
> 基于各自源码 / README / ARCHITECTURE.md 核验，标注来源，不臆测。
> 日期：2026-08-13

---

## 0. 一句话定位

| 项目 | 定位 | 底层引擎 | 语言/形态 |
|---|---|---|---|
| **zmzai-agent** | 云端多租户 Agent 编排框架（Workspace=智能体） | `@earendil-works/pi-agent-core` + relay streamFn | TS / Next.js / npm 包 |
| **deepseek-harness (dsh)** | 探索「时空可组合性」的插件化 agent runtime | Cordis（自研运行时） | TS+Python / Web UI |
| **DeepSeek-Reasonix** | 为 DeepSeek 模型字节级调优的「可常驻」终端 agent | 自研单 agent loop | Go / 静态二进制 + TUI |

三者取向完全不同：zmzai 是**云编排平台**，dsh 是**架构实验**，Reasonix 是**模型调优工程**。所以借鉴不是抄架构，是抄**机制**。

---

## 1. 核心循环（Agent Loop）对比

### zmzai-agent 现状（`runner.ts:298-313`）

```
SessionRunner.runLoop()
  └─ new Agent({                       ← pi-agent-core
       systemPrompt / model / tools / messages
       streamFn: relayStreamFn         ← lib/relay-agent-stream.ts
       toolExecution: "sequential"     ← 全部串行
       transformContext: compaction    ← 可选
       shouldStopAfterTurn: steps≥12   ← 步数上限
     })
  └─ agent.prompt(text)
       └─ PI 内部循环：LLM→(beforeToolCall权限闸)→工具→LLM...
  └─ 失败：isRetryableError → 注入合成 user 消息 → agent.continue() 一次
```

**已有能力：**
- ✅ PI 驱动的标准 ReAct 循环
- ✅ `beforeToolCall` 单一权限闸口（`runner.ts:323`）
- ✅ 上游中断自动重试一次（F6，`runner.ts:379-395`）
- ✅ relay 层空响应重试一次（`relay-agent-stream.ts:266-279`）
- ✅ 步数上限 `shouldStopAfterTurn`
- ✅ 子代理（subagent，深度上限）

**关键差距：**
- ❌ `toolExecution: "sequential"` —— 全部工具串行，无并发
- ❌ 无 Tool-Call 修复管线（模型吐坏 JSON / 漏参数 / 调用风暴时只能失败）
- ❌ 无前缀缓存意识（context 结构没有为缓存命中优化）
- ❌ Compaction 策略单一（只在超窗时整体摘要，无轮末按结果压缩）

### dsh

- 插件化驱动，循环本身是「插件编排」，没有固定的 ReAct 形态
- Cordis 运行时强调时空可组合性（论文级概念，实现细节未公开）
- **对我们的借鉴**：理念 > 实现（见 §3 P3）

### Reasonix（真正的高密度干货）

**四大支柱，每一根都是字节级工程：**

#### 支柱 1 — Cache-First Loop（缓存优先）
DeepSeek 自动前缀缓存，命中只收 ~10% 费用。把 context 切三区：

```
┌─────────────────────────────────────┐
│ Immutable Prefix                    │ 每会话 hash-pin 一次 → 100% 命中
│ system + tool_specs + few_shots     │
├─────────────────────────────────────┤
│ Append-Only Log                     │ 按时间追加，永不回写历史 → 前缀稳定
│ assistant₁→tool₁→assistant₂→...    │
├─────────────────────────────────────┤
│ Volatile Scratch                    │ 每轮重置 → 放 R1 思考/临时 plan
└─────────────────────────────────────┘
```
- **并行工具分发**：声明 `parallelSafe:true` 的只读工具 `Promise.allSettled` 并发，结果**按声明顺序**回写（保 cache 稳定）；副作用工具强制串行 barrier。

#### 支柱 2 — Tool-Call Repair（四遍修复管线）
针对 DeepSeek 实测失败模式：
- **Flatten**：>10 参数或深嵌套 schema → 自动点号扁平化，执行前还原
- **Scavenge**：正则+JSON 解析扫 reasoning，捞回模型没正常 emit 的工具调用
- **Truncation**：检测 max_token 导致的 JSON 不闭合，补括号或请求续写
- **Storm**：滑窗内抑制相同 (tool,args) 元组，注入 reflection turn 防调用风暴

#### 支柱 3 — Cost Control
- **分层默认**：默认 flash 便宜模型，硬任务升 pro；summary/subagent 硬绑 flash
- **轮末自动压缩**：工具结果 >3000 token 在轮末压缩，后续轮只看摘要；40% 上下文占比主动触发
- **自报升级**：模型可 emit `<<<NEEDS_PRO>>>`，中止重试到 pro

#### 支柱 4 — Permission
- 每 workspace shell allowlist（精确前缀匹配）
- TUI 三模态：`ShellConfirm` / `EditConfirm` / `PlanConfirm`
- JSONL session + EditHistoryEntry 支持 `/undo /history /show`

---

## 2. 分维度对比矩阵

| 维度 | zmzai 现状 | dsh | Reasonix | zmzai 借鉴价值 |
|---|---|---|---|---|
| **循环引擎** | pi-agent-core（成熟） | Cordis（实验） | 自研单 loop | 维持 PI，不换 |
| **工具并发** | ❌ 全串行 | — | ✅ parallelSafe 标记+顺序回写 | 🔴 P1 |
| **工具调用修复** | ❌ 无 | — | ✅ 四遍管线 | 🔴 P0 |
| **前缀缓存优化** | ❌ 无意识 | — | ✅ 三区结构 | 🔴 P0 |
| **上下文压缩** | 🟡 超窗整体摘要 | — | ✅ 轮末按结果+40%主动 | 🟠 P1 |
| **成本分层** | ❌ 单模型 | — | ✅ flash/pro + 自报升级 | 🟡 P2 |
| **权限系统** | ✅ 单一闸口+once缓存+always持久化 | — | ✅ allowlist+前缀匹配 | 🟢 已领先，微调 |
| **子代理** | ✅ 深度上限+权限继承 | — | ❌ 明确列为 non-goal | 维持 |
| **插件化** | 🟡 workspace 自定义 agent+skills | ✅✅ 一切皆插件 | 🟡 配置+MCP | 🟡 P2 理念 |
| **可常驻/检查点** | 🟡 lease + FIFO 队列 | — | ✅ JSONL + /undo | 🟠 P1 |
| **agent 可读协议** | ❌ 无 | ✅ AGENTS.md | — | 🟡 P2 |
| **分发** | npm 包 | npx 零安装 | 单静态二进制 | 🟢 各有场景 |

---

## 3. zmzai 优化点（按 ROI 排序）

### 🔴 P0-1：Tool-Call Repair 四遍管线

**现状痛点**：zmzai 当前工具调用一旦 JSON 损坏 / 参数缺失 / 调用风暴，只能靠 PI 抛错→relay 层重试一次→失败。DeepSeek 模型这些失败模式是**高频实测问题**（你 builtins.ts 里 `splitProgram` 就是为了 patch 模型把整条命令塞进 program 的行为——说明你已经在打补丁了，但没有系统化）。

**落地位置**：`packages/agent-framework/src/core/tools/adapter.ts` 的 `adaptTool`，在 `execute` 前加修复层。

**实现思路**：
```
adaptTool(def, ctx)
  ├─ flattenParams(jsonSchema)        ← >10参数/深嵌套时点号扁平化
  ├─ execute(id, raw):
  │    ├─ repaired = scavengeAndRepair(raw)   ← 正则捞回 + JSON 补全
  │    ├─ parsed = def.parameters.safeParse(repaired)
  │    └─ ...（现有逻辑）
  └─ stormGuard(toolName, args)       ← 滑窗去重（需在 runner 层做，见下）
```
- **Flatten/Scavenge/Truncation** 三遍可在 adapter 内独立完成，**不碰 PI**，改动面最小
- **Storm** 需要跨轮记忆，放 runner 层（`beforeToolCall` 里维护滑窗 Set）

**预期收益**：工具调用成功率显著提升，模型重试轮次下降 → 直接降成本。

---

### 🔴 P0-2：前缀缓存三区结构

**现状痛点**：zmzai 的 `transformContext` 只有 compaction 一个变换，且 compaction 会**重写历史**（`compaction.ts:77-82` 把 head 压成一条 user 消息）——这会**击穿前缀缓存**，压缩后第一次请求全 miss。

**Reasonix 的解法**：
1. Immutable Prefix：system+tools+few_shots，hash pin，永不改
2. Append-Only Log：历史只追加，不回写
3. Volatile Scratch：每轮重置的临时区

**zmzai 落地思路**（需确认 relay 是否透传缓存计费——目前 `cost` 全 0，`relay-agent-stream.ts:33`，说明缓存计量还没接）：
- **第一步**：保证 `agentInfo.prompt` + `piTools` 的 JSON schema 在整个会话**字节级稳定**（现在 tools 列表每轮 rebuild，顺序/内容若有抖动就 miss）
- **第二步**：compaction 改为「只删尾部旧消息 + 保留最近 N 轮」，而非「重写成一条摘要消息」——摘要放 Volatile 区，不污染 Append-Only 区
- **第三步**：把 PI 的 reasoning/thinking 输出放 Volatile 区（当前 pi-bridge 把 reasoning 当持久 part 追加，`pi-bridge.ts:155`，可能影响缓存）

**前置依赖**：需要 relay 层先支持缓存计费回传（`usage.cacheRead/cacheWrite`），否则优化无法度量。

---

### 🟠 P1-1：工具并发执行

**现状**：`runner.ts:310` 硬编码 `toolExecution: "sequential"`。read/glob/grep 这种纯读工具完全可以并发。

**落地**：
- `ToolDef` 已经有 `executionMode?: "sequential" | "parallel"` 字段（`def.ts:19`），builtins 里 write/edit/bash 已标 sequential
- 但 runner 没用它，直接传 `"sequential"` 给 PI
- **改法**：把 `toolExecution` 改为按工具声明决定，或让 PI 读 `executionMode` 字段（需确认 pi-agent-core 是否支持 per-tool mode）
- **注意**：Reasonix 强调并发结果必须**按声明顺序回写**才能保缓存——这是硬约束，不能 `Promise.race` 后乱序 append

---

### 🟠 P1-2：轮末按结果压缩（精细化 compaction）

**现状**：compaction 只在「估算 token + reserve ≥ contextWindow」时触发整体摘要。

**Reasonix 做法**：
- 单条工具结果 >3000 token → **轮末立即压缩**，只对当轮保留全文，后续轮只见摘要
- 40% 上下文占比 → 主动触发整体压缩

**zmzai 落地**：在 `adaptTool` 的 `truncateOutput`（当前 48KB 硬截断，`adapter.ts:7`）之上，加一层「异步摘要替换」——工具返回后先给模型全文（当轮用），轮末用 summary 模型压成摘要写回历史。比当前「超窗才压」更省 token。

---

### 🟡 P2-1：成本分层 + 模型自报升级

**现状**：单模型，`createRelayModel` 写死（`relay-agent-stream.ts:23`）。

**落地**：
- workspace 配置加 `modelTier: "flash" | "pro"`
- summary/subagent 硬绑 flash（compaction 的 `summaryModel` 已经是独立配置，`runner.ts:56`，只需默认指 flash）
- 可选：system prompt 里告诉模型可以 emit `<<<NEEDS_PRO>>>`，runner 拦截后换模型重试

---

### 🟡 P2-2：AGENTS.md 原生协议

**现状**：zmzai 的 workspace 已有 `.zmzai/agents/*.md`（`runner.ts:226` 注释），但是给**框架自己读**的。

**dsh 做法**：`AGENTS.md` 是给**外部 AI agent**（如 Cursor/Claude Code）读的项目规范，标准化 agent 与代码库的交互。

**落地**：为每个 workspace 自动生成 `AGENTS.md`（含工具列表、权限策略、沙箱限制、产物路径），让外部 agent 能直接理解 zmzai workspace 的约定。这对你的 `coding-agent-plan`（任务级授权+沙箱产物回传）是天然补全。

---

### 🟢 P3：插件化哲学（仅理念吸收）

dsh 的「一切皆插件」+ Cordis 运行时迁移成本极高，**不建议照搬**。但理念可吸收：
- zmzai 的 workspace 自定义 agent + skills 已经是半插件化
- 可以把 permission ruleset / tool / model provider 进一步统一为「插件清单」，让 workspace 用一份配置声明所有扩展

---

## 4. 落地路线图建议

```
阶段一（立即，1-2天）── 见效最快，改动面最小
  ├─ P0-1 Tool-Call Repair：在 adapter.ts 加 Flatten/Scavenge/Truncation
  └─ P1-1 工具并发：确认 PI 是否支持 per-tool executionMode，改 runner

阶段二（1周）── 需 relay 配合
  ├─ P0-2 前缀缓存三区：先让 relay 回传 cacheRead/cacheWrite 计费
  └─ P1-2 轮末按结果压缩：compaction 分层化

阶段三（按需）
  ├─ P2-1 成本分层
  ├─ P2-2 AGENTS.md 生成
  └─ P3 插件化统一（长期）
```

---

## 5. 关键纠偏

> 前期抓取 Reasonix 时，模型一度总结出「planner+executor 双模型并行 / Extension Protocol v1 / ACP 集成」等内容——**经核验其 README 和 ARCHITECTURE.md 均不存在**，属幻觉。Reasonix 官方明确把 multi-agent orchestration 列为 **non-goal**，走单 agent + 分层模型路线。本文件所有 Reasonix 特性均来自其 `docs/ARCHITECTURE.md` 实际内容。

> dsh 的 README 极薄，Cordis 运行时实现未公开。本文件对 dsh 只引用其明确声明的「一切皆插件」「时空可组合性」「AGENTS.md」三点，不展开未公开细节。
