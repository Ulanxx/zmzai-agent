# 可借鉴技术清单（源码级核验版）

> 基于对 `deepseek-harness`(dsh) 和 `DeepSeek-Reasonix` 两个仓库**真实源码**的精读
> （Reasonix `main-v2` 分支 + dsh `master` 分支，已下载至 `/tmp/zmzai-research/`）
> 日期：2026-08-13。本文档取代 `architecture-comparison.md` 中基于 README 摘要的优化点章节。

---

## 0. 对上一轮分析的纠正（重要）

| 之前结论 | 实际源码事实 | 证据 |
|---|---|---|
| ❌ Reasonix「planner+executor 双模型」是幻觉 | ✅ **真实双模型**：`Coordinator` 独立跑 planner 模型 + executor 模型 | `internal/agent/coordinator.go` + `planner_route.go` |
| ❌ Reasonix「多智能体」是 non-goal | ✅ **真实多智能体**：fleet DAG + scheduler 写路径槽位 + parallel_tasks | `fleet.go` / `scheduler.go` / `parallel_tasks.go` |
| ❌ Reasonix「Extension Protocol / ACP」是幻觉 | ✅ **都真实存在** | `internal/acp/*` + `cmd/extension-protocol-gen/` |
| 🟡「三区上下文」是 immutable/append/volatile 三个字面结构 | 实际是 **canonical 转录(append-only) + durable projection(pinned前缀+digest+近期tail) + volatile scratch** 三层 | `context_manager.go` / `compact_projection.go` |

**教训**：Reasonix 的 README/ARCHITECTURE.md 描述的是**早期版本**，`main-v2` 分支已经演进成双模型 + 多智能体。dsh 比 README 看起来**强得多**（49 包、自带 pi-ai 适配器）。

---

## 1. Reasonix 可借鉴点（按 ROI 排序）

### ⚠️ 1.0 缓存优化的前提查证（关键，先读这节再读本章其余部分）

> 2026-08-14 补充：本节是「Review 我的 Review」+ relay 源码查证后的硬结论。**它推翻了下文原 P0-1 的「省钱」收益定性。**

**zmzai 是多模型平台**（DeepSeek 原生 + ChatGPT 中转，channel 动态路由）。前缀缓存不是统一机制，而是**每个上游 channel 的属性**。查证 relay 源码后发现两条 cache 收益链路是**断的**：

**断点 A — relay 不按 cache 折扣计费。** `zmzai-relay/app/api/v1/chat/completions/route.ts:137-138`（非流式）与 `:163`（流式）计费只读两个字段：
```js
const prompt = tokens.prompt_tokens ?? 0;
const completion = tokens.completion_tokens ?? 0;
charged = chargeMicros(prompt, inputPrice) + chargeMicros(completion, outputPrice);
```
DeepSeek 的 `prompt_cache_hit_tokens` / dsh `translate.ts` 翻译的 `cacheReadTokens`——**relay 不读、不传、不存**。`UsageModel.settle` 也只存 `promptTokens/completionTokens`。结论：**即使上游缓存 100% 命中，zmzai 仍按全量 prompt_tokens 收费，zmzai 自己省不到钱**。

**断点 B — zmzai-agent 不收 cache 字段。** `zmzai-agent/lib/relay-agent-stream.ts:33` 的 `emptyUsage()` 把 cacheRead/cacheWrite 全填 0，`usage` 压根没解析。结论：**zmzai 连「这次命中没有」都看不到**，PrefixShape 诊断永远输出空数据。

**上游混合的额外影响：** zmzai-agent 在请求时不知道会落到有缓存的 DeepSeek channel 还是没缓存的 ChatGPT 中转（`ChannelModel.find().sort({priority:1})` 动态选）。所以即便修好断点，"缓存优化"也**只对支持缓存的 channel 有效**。

**对原 P0-1（schema 排序 + PrefixShape）的影响：**
- ❌ 「省钱」收益是**幻觉**（断点 A 未修，且 ChatGPT 中转无缓存）
- 🟡 「降首 token 延迟」收益**真实但当前无法度量**（断点 B 未修，且仅对 DeepSeek channel 有效）
- ⇒ **P0-1 从 P0 降为 P1**，且依赖下文断点 A/B 先修好

**多模型平台决定了 cache 必须做成 channel 属性（不能写死 DeepSeek）：** 现有 channel schema（`zmzai-relay/providers/channels/schema.ts:4`）只有 baseUrl/models/priority/成本/enabled/timeoutMs，没有任何 cache 概念。正确抽象见 §1.1-A。

### 🔴 1.1-A（断点 A）：relay channel 加 cache 属性 + 折扣计费 [真 P0]

**zmzai 落地**（`zmzai-relay/providers/channels/schema.ts` + `app/api/v1/chat/completions/route.ts`）：

1. channel schema 加属性（字段名待定，先表达意图）：
```ts
supportsPromptCache?: boolean   // DeepSeek=true，多数 ChatGPT 中转=false
cacheDiscountRatio?: number     // DeepSeek≈0.1（命中部分按 10% 计价）
```
2. 计费逻辑（route.ts:137-138 / 163）改为命中部分折后计价：
```ts
const cacheHit = channel.supportsPromptCache ? (tokens.prompt_cache_hit_tokens ?? 0) : 0;
const miss = Math.max(0, prompt - cacheHit);
const inputCharge = chargeMicros(cacheHit, inputPrice) * (channel.cacheDiscountRatio ?? 1)
                  + chargeMicros(miss, inputPrice);
```
3. DeepSeek channel 开 cache + 0.1 折扣；ChatGPT 中转 channel 关 cache、全价。**同一套代码、两种上游、零特殊判断**。

### 🔴 1.1-B（断点 B）：zmzai-agent 解析 cache 字段 [真 P0]

**zmzai 落地**（`zmzai-agent/lib/relay-agent-stream.ts`）：把 `emptyUsage()` 和 chunk 解析改成真实读取（relay 已透传 response body，只是自己不解析）。借鉴 dsh `llm-deepseek/translate.ts` 的 `mapUsage`：`inputTokens = prompt_tokens - cached_tokens`，`cacheReadTokens = cached_tokens`。这是 PrefixShape 诊断有数据的前提。

**⚠️ 计费对账风险：** relay 流式计费本来就有脆弱点（route.ts:162「上游漏 usage 就不扣费」= unsettled）。再叠一层 cache 字段依赖后，若上游某版本字段名/时序错位，**折扣可能算错**（命中算成未命中 = 多收，反之 = 少收）。做断点 A 时必须配套扩展 `ChannelAttempt.costStatus` 校验 cache 字段是否解析成功，纳入对账。

### 🟡 P1（原 P0-1）：缓存稳定性 = 工具 schema 排序 + 前缀哈希诊断

> 依赖 §1.1-A/1.1-B 修好。收益：降首 token 延迟（仅支持缓存的 channel）；省钱收益归 §1.1-A，不归本项。

**源码**：`internal/agent/cache_shape.go`

```go
// 关键：对工具 schema 做确定性排序，保证 tools 哈希稳定
func normalizeToolSchemas(schemas []provider.ToolSchema) []provider.ToolSchema {
    // 按 Name → Description → Parameters 排序
}

type PrefixShape struct {
    SystemHash string   // sha256(systemPrompt) 截断 8 字节
    ToolsHash  string   // sha256(排序后的工具 schema JSON)
    PrefixHash string
}
```

**为什么仍是 P1**：前缀缓存命中的前提是 system + tools 字节稳定。zmzai `adaptTool` 里 `z.toJSONSchema` 生成 schema，工具数组顺序是 `builtinTools` 声明顺序——workspace 自定义 agent/tool 顺序一变，前缀缓存全 miss。修好断点 B 后，schema 排序让命中稳定，PrefixShape 才能诊断出真实命中趋势。

**zmzai 落地**（`packages/agent-framework/src/core/tools/adapter.ts`）：
1. 在 `adaptTool` 生成 JSON schema 后，对工具数组做确定性排序（by name），再交给 PI（排序在 `runner.ts:295` 的 `.map(adaptTool)` 前加一次 `.sort`，权限匹配 `permissionForCall` 按 map 查找不依赖顺序，安全——但需跑 `npm test` 验证 PI 不对 tools 数组顺序敏感）
2. 加 `PrefixShape` 等价物：hash system + tools，每次请求前对比，记录 `PrefixChanged` 原因到 event log

### 🔴 P0-2：调用风暴断路器（signature + streak 双检测）

**源码**：`internal/agent/storm_breaker.go`（我最看重的文件，全文已精读）

```go
const stormBreakThreshold = 3          // 连续 3 次同样的失败 → 打断
const repeatSuccessBreakThreshold = 2  // 连续 2 次同样的"写成功" → 打断

// 签名检测：key = (tool name, error/blocker)，NOT args
// 关键设计：卡住的模型会"化妆"参数重试（换个说法但打到同样的 host 拒绝），
// 所以按 args 匹配会漏掉。按 (name, host响应) 匹配才准。
func batchStormSignature(calls, outcomes) (string, bool) {
    // 每个 call 的 name + "\x00" + errMsg，拼接成签名
}

// streak 检测：连续 N 轮"全部调用都被 block"（不管形态）
```

**触发的处理不是回显错误，而是注入"改变策略"指令**：
```
"[loop guard] X 已经连续 3 次以相同的主机响应失败/被拒绝。
 换措辞重发没有用：调用会继续命中同样的结果。如果参数被截断，
 就拆成几个更小的调用；否则修正参数、换工具、或在最终答案里说明阻塞原因。"
```

**为什么这是 P0**：zmzai 现在**完全没有** storm 防护。模型如果陷入「参数太长→截断→重发→再截断」的死循环，会烧掉整个 `shouldStopAfterTurn` 的 12 步预算，最后用户看到一堆重复错误。

**zmzai 落地**（`packages/agent-framework/src/core/runtime/runner.ts` 的 `beforeToolCall` 或 `shouldStopAfterTurn` 旁）：
- 在 runner 维护 per-turn 的 `stormCount` + `blockedTurnStreak` + 签名
- 阈值 3，命中后在下一个 tool result 里注入"改变策略"文本（不是终止，是 redirect）
- 签名按 `(toolName, 错误/权限拒绝原因)` 而不是 args

### 🔴 P0-3：重复失败守卫（语义签名 + 状态复查）

**源码**：`internal/agent/repeat_failure_guard.go`

```go
const repeatFailureBreakThreshold = 2

// 语义签名：edit_file → {Path, OldString}；不按字面 args
// 错误分类：old_string_not_found / old_string_not_unique
// 关键：block 前先 Preview() 复查状态是否真的没变，
//       如果文件已经变了就删除记录、放行（避免误伤）
```

**zmzai 落地**：`editTool`（`builtins.ts`）最常见的失败就是 `oldText 不唯一/不存在`。加一个 per-task 的重复失败计数，`edit` 失败时按 `(path, oldText)` 记签名，连续 2 次同类失败后，第 3 次先 `workspace.read` 复查文件内容是否变化再决定放不放行。

### 🟠 P1-1：重复"写成功"守卫（防写循环）

**源码**：`storm_breaker.go` 的 `repeatSuccessBreakThreshold = 2`

**关键洞察**：不只是防"失败风暴"，还要防**「成功的写循环」**——模型连续 3 次对同一路径做相同 write/edit（每次都说"成功"），实际是无意义循环。zmzai 的 `writeTool`/`editTool` 同样适用。

### 🟠 P1-2：失败日志剪裁（保留失败行，掐掉通过噪音）

**源码**：`internal/agent/failure_snip.go`（已全文精读）

```go
failureContextLines = 2   // 失败行两侧各留 2 行
failureMaxKeptLines = 60  // 上限
failureMinLines     = 24  // 低于此行数就整个保留
failureMarkers = ["fail","error","panic:","fatal","assert","expected",
                  "want:","got:","exit status","undefined:","cannot ",
                  "no such","timeout","timed out"]
```

**关键洞察**：失败的 `go test` 日志大部分是"通过的用例"，keep 策略会永远保护整段。这个函数把失败日志剪到**只留携带失败信息的行**，节省大量 token 又不丢诊断信息。

**zmzai 落地**：`adapter.ts` 的 `truncateOutput`（当前 48KB 硬截断）替换/叠加为「先按失败标记剪裁，再按字节截断」。

### 🟠 P1-3：并行工具分发 + 顺序回写

**源码**：`internal/agent/execute_batch.go`

```go
// 只有"已知且只读"的工具才进并行 batch
func parallelisable(r, name) bool {
    case "complete_step","todo_write","wait","bash_output","use_capability","compress":
        return false
    // 其余：resolve 后要求 ReadOnly() 且无歧义
}
const maxParallel = 8  // goroutine 上限

// 结果按 index 存，不按完成顺序；回写历史按 call 顺序
```

**zmzai 落地**：`runner.ts:310` 现在硬编码 `toolExecution: "sequential"`。PI 的 `ToolExecutionMode` 默认就是 `parallel`，且支持 per-tool `executionMode`（已在 `def.ts:19` 定义了但没用）。**先搞清楚当初为什么选 sequential（大概率是权限闸口+沙箱 snapshot 一致性的顾虑），再决定切不切**。read/glob/grep 是纯读，天然 parallel。

### 🟠 P1-4：精细化 compaction（投影式，不改 canonical）

**源码**：`internal/agent/compact.go` + `compact_projection.go`

核心机制（比 zmzai 现在先进一个量级）：
```
canonical 转录（永不被重写）
        ↓ 计算
durable projection = [pinned 前缀] + [一条 digest] + [近期 verbatim tail]
```

关键常量：
```go
defaultCompactRatio      = 0.85   // 触发阈值（窗口的 85%）
recentTailBudgetRatio    = 0.10   // 近期 tail 预算（10%，clamp 32K-96K）
summaryOutputMaxTokens   = 16*1024
maxPinnedFirstUserTokens = 1500   // pin 首条 user 轮
keptUserTurnsBudgetTokens= 8192
minRecentKeep            = 2
```

关键设计（zmzai 缺失的）：
1. **永不切分工具调用对**（`toolPairingBalanced`）——tail 边界对齐，避免 tail 开头是孤儿 tool result
2. **digest 不再链式累积**（旧的 digest 合并进新摘要，避免"摘要的摘要"）
3. **失败日志保错**（KeepErrors）+ 用户标记保段（`[[keep]]` 前缀）
4. **摘要必须更小**才提交，否则放弃
5. **退化回退**：summarizer 失败时用机械 digest（"N 条消息被折叠"）而不是硬失败

**zmzai 落地**：`compaction.ts` 现在只做「head 整体压成一条 user 消息」，且会**重写历史击穿缓存**。改为投影式：canonical 消息不动，维护一个 `projection` sidecar，模型可见的是投影；tail 按 token 预算保留；工具调用对不切分。

### 🟡 P2-1：成本控制（预算轴 + 输出裁剪 + reasoning 降档）

**源码**：`run_budget.go` / `output_budget.go` / `governor.go`

```go
// 预算检查顺序：token → cost → time，且在"轮次之前"检查
func (r *runBudget) exceeded(limit) { /* token→cost→time */ }

// 输出预算：与窗口共享时裁剪，CJK 感知的 token 校准
const outputBudgetReserve = 8 * 1024

// governor：探索期（无验证债、无本地执行、上轮思考昂贵）→ reasoning 降到 low
```

**zmzai 落地**：`runner.ts` 目前只有 `shouldStopAfterTurn`（步数上限）。加 token/cost 预算轴，`run_budget` 式在每轮前检查。**注意**：cost 预算依赖真实的 usage 数据，而 cache 字段解析归 §1.1-B（断点 B）——断点 B 没修好之前，这里的 cost 统计也是失真的。

### 🟡 P2-2：路径绑定的写权限（子代理写路径隔离）

**源码**：`internal/agent/path_bound_tools.go` + `scheduler.go`

```go
// 写工具被 WritePathSet 包裹，超出声明路径直接拒绝
pathBoundWriterNames = ["write_file","edit_file","multi_edit","move_file",...]
// scheduler：子代理并发 + 写路径非重叠声明（先 preflight 再启动）
```

**zmzai 落地**：`spawnSubagent`（`runner.ts:428`）目前子代理继承父的全部 permission，**没有写路径隔离**。借鉴 `WritePathSet`：子代理声明 `write_paths`，超出范围拒绝。这是 zmzai 子代理系统（`coding-agent-plan` 里的任务级授权）的自然升级。

### 🟢 P3：双模型 planner + fleet 多智能体

Reasonix 的 `Coordinator`（planner 独立模型 + executor）和 `fleet`（DAG 依赖 + 写路径非重叠 preflight）是**大架构**。zmzai 已经有子代理（深度上限+权限继承），短期不必要上双模型。**仅记录为长期方向**：当 workspace 任务复杂到需要"先规划再执行"分离时，可借鉴 planner 用只读工具 + `submit_plan` 的结构化退出。

---

## 2. dsh 可借鉴点

### 🔴 P0：工具结果确定性裁剪（无模型，head+tail）

**源码**：`packages/compaction/compaction-tool-result-pruner/src/index.ts`

```
按 Unicode code point 计，超过 thresholdChars → 保留 head + tail，中间替换为 PRUNE_MARKER
```

**关键洞察**：这是**确定性、零 LLM 成本**的工具结果裁剪，比"调 summary 模型压缩"便宜得多。zmzai 的 `adaptTool.truncateOutput`（48KB 硬截）可以升级为「先 head+tail 裁剪，超了再上 LLM 摘要」。

### 🔴 P0：重复调用提醒（advisory，阈值 [3,5,8]，深排序参数规范化）

**源码**：`packages/guard/repeat-tool-reminder/src/index.ts`

```ts
thresholds = [3, 5, 8]
// 关键：参数规范化用深 key 排序（JSON 对象 key 排序后 stringify），
//       这样 {a:1,b:2} 和 {b:2,a:1} 视为同一调用
canonicalize(args) = JSON.stringify(sortJsonValue(args))
// 用户插入新消息 → 中断链（reset）
```

**与 Reasonix 的 storm breaker 互补**：Reasonix 按 (name, error) 拦失败风暴；dsh 按 (name, 深排序 args) 提醒重复调用。**建议 zmzai 两个都上**：失败风暴用 Reasonix 式拦截，重复调用用 dsh 式 advisory 提醒。

### 🟠 P1：compaction 事务（稳定性检查 + 摘要必须更小 + 持久锁）

**源码**：`packages/compaction/compaction-basic/src/region.ts`

```ts
// 提交前做 deep-equal 稳定性检查（whole-surface 或 selected-span），
// 摘要生成期间会话变了就放弃重来
// 摘要必须更小才提交：framedSummary >= shadowed → 抛错
// 用 compaction/start 事件作为"持久锁"，防并发 compaction
// 摘要指令作为"最后一条 user 消息"而非 system prompt → 复用 KV 缓存前缀
```

**zmzai 落地**：`compaction.ts` 的 `createCompactionTransform` 没有并发锁、没有稳定性检查、没有"更小才提交"保证。这些都是可直接抄的健壮性补强。

### 🔴 P0：缓存计费（DeepSeek usage 翻译）—— 即 §1.1-B 断点 B

> 此项已并入 §1.1-B（真 P0）。重复记录于此以保留 dsh 源码出处。

**源码**：`packages/llm/llm-deepseek/src/translate.ts`

```ts
// 关键：prompt_tokens 是"含缓存命中"的，要减去 cached_tokens
inputTokens = prompt_tokens - (prompt_tokens_details?.cached_tokens ?? prompt_cache_hit_tokens)
cacheReadTokens = cached_tokens
```

**zmzai 落地**：`relay-agent-stream.ts` 的 `emptyUsage()` 全 0，`usage` 解析完全没接。借鉴这段把 `cached_tokens` 翻译成 cacheRead/cacheWrite。**注意**：这是多模型平台，翻译逻辑要按 channel 是否声明 `supportsPromptCache` 决定（见 §1.1-A），不能假设全是 DeepSeek。

### 🟡 P2：LLM 适配器分层（maxRetries:0 模式）

**源码**：`packages/llm/llm-pi-ai/src/adapter.ts`

```ts
// 关键设计：适配器层 maxRetries = 0，
// "agent recovery layer owns visible attempts; one adapter call = one SDK attempt"
```

**zmzai 落地**：zmzai 现在 `relay-agent-stream.ts` 里 relay 层有重试 + runner 层 `isRetryableError` 又重试，两层重试可能叠加。借鉴 dsh 的清晰分层：**适配器/relay 层不重试，重试归 agent recovery 层管**。

### 🟡 P2：Skill 分层注册（rank 优先级 + collect 缓存）

**源码**：`packages/skill/skill/src/index.ts`

```ts
// 分层：project > runtime > user；同层按 rank（数字越小越优先）
// name 校验：kebab-case
// collect 缓存：cacheKey = {cwd, scopes, revision}，128 条上限
```

**zmzai 落地**：zmzai 的 workspace 已有 `.zmzai/agents/*.md` + skills。dsh 的 skill registry 的**分层优先级 + rank + 缓存失效**模式，可借鉴给 zmzai 的 workspace-skills 系统（`lib/workspace-skills.ts`）。

### 🟢 P3：可嵌入 SDK（JSON-RPC over stdio）+ ACP

dsh 的 `packages/sdk/server` 是**可嵌入的 JSON-RPC 服务**（stdio 传输），`packages/acp` 是 ACP 编解码。**对 zmzai 的价值**：如果未来想让 zmzai workspace 被外部 agent（Cursor/Claude Code）驱动，ACP 是标准化的接入面。**记录为方向，不急于实现。**

---

## 3. 最关键的跨项目洞察

**dsh 和 Reasonix 各自独立收敛到了同一套机制**，这比任何单一实现都有说服力：

| 机制 | Reasonix | dsh | 价值判断（已按 §1.0 查证调整） |
|---|---|---|---|
| 工具结果裁剪 | `failure_snip.go` + `snipToolResult` | `compaction-tool-result-pruner` | ✅ 必做（P0） |
| 重复调用/风暴防护 | `storm_breaker.go`（拦截）+ `repeat_failure_guard.go` | `repeat-tool-reminder`（提醒） | ✅ 必做（P0） |
| compaction 投影式 + 不切工具对 + 摘要更小 | `compact_projection.go` | `region.ts` | ✅ 必做（P1） |
| **缓存计费（断点 A+B）** | `CompareShape`（miss/hit tokens） | `translate.ts`（subtract cached） | 🔴 **真 P0**，多模型平台须做成 channel 属性（见 §1.1） |
| 前缀缓存稳定性（schema 排序） | `cache_shape.go` | `summarizer.ts` | 🟡 P1，**依赖断点 A+B 修好**才有度量意义；省钱收益归断点 A 不归本项 |
| 并行 + 顺序回写 | `execute_batch.go`（index 存结果） | `tool-calls.ts`（commitReady 按序） | 🟡 视 PI 能力（PI 默认 parallel，先查 zmzai 为何选 sequential） |

**这条收敛意味着**：这些不是某个项目的怪癖，而是「AI coding agent 在 DeepSeek 类模型上」的**通用最佳实践**。zmzai 照抄不会错。

---

## 4. 落地路线图（修订版 v2，反映 §1.0 cache 前提查证）

> 关键变化：cache 基础设施（断点 A+B）从「阶段二」提前到 **真 P0**；原 P0-1 schema 排序降到 P1（依赖断点修好）。两条 P0 并行轨道：① cache 基础设施（跨 relay+agent）② loop 防护（纯 agent 内）。

```
P0 轨道 ① — cache 基础设施（让 cache 可见 + 可计费，多模型平台的正确抽象）
  ├─ 1.1-A  relay channel 加 supportsPromptCache + cacheDiscountRatio + 折扣计费
  │        + ChannelAttempt costStatus 扩展校验 cache 解析（防断点 A 重蹈 unsettled 覆辙）
  └─ 1.1-B  zmzai-agent 解析 cache 字段（emptyUsage→真解析，借鉴 dsh mapUsage）

P0 轨道 ② — loop 防护（不依赖 cache，纯 agent 内，可立即并行）
  ├─ P0-2  调用风暴断路器（runner afterToolCall，signature[按 name+error 非 args]+streak，阈值 3）
  ├─ P0-3  重复失败守卫（runner afterToolCall，语义签名，阈值 2；block+复查走 beforeToolCall）
  └─ P0    dsh 工具结果 head+tail 确定性裁剪（adapter.ts，只裁 output 文本不动 artifacts）

P1 — 依赖 P0 ① 修好后才有度量意义
  ├─ schema 确定性排序 + PrefixShape 诊断（adapter.ts，需 npm test 验 PI 顺序不敏感）
  ├─ compaction 投影式改造（compaction.ts，canonical 不动 + tail 预算 + 不切工具对）
  ├─ compaction 事务补强（稳定性检查 + 摘要更小才提交 + 持久锁）
  └─ 重复"写成功"守卫 + 重复调用 advisory 提醒（dsh thresholds [3,5,8] 深排序 args）

P2/P3 — 按需
  ├─ 成本预算轴 + reasoning 降档（runner.ts）
  ├─ LLM 适配器分层（relay 不重试 / agent recovery 层重试，maxRetries:0）
  ├─ 子代理写路径隔离（spawnSubagent + WritePathSet）
  └─ Skill 分层注册、可嵌入 SDK/ACP、双模型 planner/fleet（长期方向）
```

**⚠️ Review 中确认的落点细节**（写代码时务必遵守，避免返工）：
- storm 断路器落点是 `agent.afterToolCall`（覆盖 result.content 注入"改变策略"），**不是** `beforeToolCall`（只能 block，无 content override）。且只处理「成功执行但死循环」，不碰 error/retry 路径，避免与 F6 `isRetryableError` 重试打架。
- 重复失败守卫的「拦截+状态复查」走 `beforeToolCall`（能 block 能复查），「策略注入」走 `afterToolCall`——PI 的 before/after 语义决定了必须拆两段。
- schema 排序的「安全」尚未真验证，须 `npm test`（PI 是否对 tools 数组顺序敏感未知）。

---

## 5. 源码位置索引（本地镜像）

- Reasonix：`/tmp/zmzai-research/reasonix/internal/agent/*.go`（24 个核心文件）
- dsh：`/tmp/zmzai-research/dsh/packages/*/src/*.ts`（12 个核心文件）
- 完整文件清单：`/tmp/reasonix_files.txt`（4375 文件）、`/tmp/dsh_files.txt`（7412 文件）

> 注意：本地镜像在 `/tmp`，重启会清空。如需保留可复制到仓库 `.research/`（已尝试 git clone 但因沙箱网络限制失败，仅能通过 `gh api` 逐文件拉取）。
