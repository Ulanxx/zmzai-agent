# M5 抽包设计：@zmzai/agent-framework

> 状态：设计确认（2026-08-11）。目标：把 `zmzai-agent/framework/` 抽成独立 npm 包，第三方 `createServer()` 可起。验收标准（spec §11）：第三方可 `createServer()` 起框架。

## 1. 现状依赖盘点（已核实）

`framework/core/{session,events,permission,agent}` 四个子树**只依赖** `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`mongoose`、`zod`——可以原样进包。

产品耦合集中在 4 处：

| 文件 | 产品依赖 | 性质 |
|---|---|---|
| `framework/server/context.ts` | `@/lib/relay-agent-stream`（模型） | **注入**：包的 `ModelProvider` 适配器，产品实现留仓库 |
| `framework/core/runtime/runner.ts` → `defaultToolContext` | `@/lib/sandbox-snapshot`、`@/lib/sandbox-execution`（沙箱） | **注入**：包的 `SandboxExecutor` 接口 |
| `framework/core/tools/mongo-workspace.ts` | `@/lib/{database/mongodb,workspace-edit,workspaces}`、`@/models/*` | **注入**：归一化为 `WorkspaceBackend`（= 现有 `WorkspaceFiles` 接口）；产品的 Mongo 实现留仓库，包提供 JSONL/FS 参考实现 |
| `framework/core/tools/context.ts` | `@/lib/sandbox-types` | 纯类型，内联进包 |

HTTP 路由（`app/api/fw/**`、`app/api/audit/**`）的产品依赖（auth/session、idempotency、api-error、artifact-storage、各 `@/models`）**不进包**——它们是产品的 server 层。包提供的是**可嵌入的 handler 工厂**，产品的 Next.js 路由薄包装它。

## 2. 包结构

```
packages/agent-framework/                # 新子包（先在 zmzai-agent 仓库内，便于联调）
├── package.json                         # name: @zmzai/agent-framework
├── tsconfig.json + tsup 构建（esm+cjs+dts）
├── src/
│   ├── index.ts                         # 公共导出（见 §4）
│   ├── core/
│   │   ├── session/   (types, store, ids, jsonl-store)      ← 从 framework/core 搬
│   │   ├── events/    (manifest, bus — 抽象 EventLog 接口)
│   │   ├── permission/(ruleset, engine)
│   │   ├── agent/     (registry, loader)
│   │   ├── tools/     (def, context, adapter, builtins, task — 去掉 mongo-workspace)
│   │   └── runtime/   (runner, pi-bridge, compaction, lease-recovery — 全部依赖注入)
│   ├── adapters/
│   │   ├── model-provider.ts    # ModelProvider 接口 + OpenAI-compatible HTTP 参考实现
│   │   ├── sandbox-executor.ts  # SandboxExecutor 接口 + 本地子进程参考实现（无沙箱隔离，演示用）
│   │   └── workspace-backend.ts # WorkspaceFiles 接口 + FS/JSONL 参考实现
│   ├── server/
│   │   ├── create-server.ts     # createServer(deps) → 框架实例 { runner, store, bus, registry }
│   │   └── http-handlers.ts     # 事件溯源的 handler 工厂（sessions/prompt/permissions/events）
│   └── cli.ts                     # zmzai-agent serve / run（见 §5）
└── openapi.yaml                   # HTTP + SSE 事件契约（见 §3）
```

## 3. 依赖注入接口（包定义，产品/第三方提供实现）

```ts
// adapters/model-provider.ts
interface ModelProvider {
  getModel(ref: ModelRef): Model<Api>;
  streamFor(session: SessionInfo): StreamFn;   // PI 的 streamFn
}

// adapters/sandbox-executor.ts
interface SandboxExecutor {
  run(input: { toolCallId: string; command: { program: string; args: string[] }; snapshot: SandboxSnapshot }): Promise<SandboxExecResult>;
  buildSnapshot(input: { userId: string; workspaceId: string }): Promise<SandboxSnapshot>;
}

// tools/context.ts (已有 WorkspaceFiles，重命名导出别名 WorkspaceBackend)
interface WorkspaceBackend /* = WorkspaceFiles */ {
  list(): Promise<{ path: string; bytes: number }[]>;
  read(path): Promise<{ path: string; content: string } | null>;
  write(...): Promise<{ revisionId: string; diff: string } | null>;
  edit(...): Promise<{ revisionId: string; diff: string } | { error: string }>;
}

// server/create-server.ts
type FrameworkDeps = {
  store: SessionStore;
  modelProvider: ModelProvider;
  sandboxExecutor: SandboxExecutor;   // 或 NoopSandboxExecutor（无 bash 能力）
  workspaceBackend: (ctx: { userId: string; workspaceId: string }) => WorkspaceBackend;
  eventLog?: EventLog;                 // 默认 in-memory bus；产品用 Mongo 投影
  compaction?: { enabled; contextWindow; summaryModel } ;
  subagentDepth?: number;
};
function createServer(deps: FrameworkDeps): AgentFramework;
```

`SessionStore` 已有（Mongo 产品实现留仓库；包带 JSONL）。`EventLog` 从 bus.ts 抽接口（persist+subscribe+read），默认 in-memory + 可选 JSONL 持久化；产品的 Mongo fw_events 实现留仓库。

## 4. 公共导出（`src/index.ts`）

```ts
export { createServer } from "./server/create-server";
export type { FrameworkDeps, AgentFramework } from "./server/create-server";
export type { SessionStore, SessionInfo, MessageInfo, Part, ToolState } from "./core/session/...";
export { createJsonlSessionStore } from "./core/session/jsonl-store";
export { AgentRegistry, builtinAgents } from "./core/agent/registry";
export { PermissionEngine } from "./core/permission/engine";
export { rulesetFromConfig, evaluateRules } from "./core/permission/ruleset";
export type { FrameworkEvent, FrameworkEventType } from "./core/events/manifest";
export type { ModelProvider } from "./adapters/model-provider";
export type { SandboxExecutor } from "./adapters/sandbox-executor";
export type { WorkspaceBackend } from "./adapters/workspace-backend";
export { ToolDef, ToolContext, builtinTools } from "./core/tools/...";
export { loadCustomAgents } from "./core/agent/loader";
```

## 5. 最小 CLI（`src/cli.ts`）

```
zmzai-agent serve [--port 3011] [--data-dir ./.fw-data]   # JSONL store + in-memory bus 起 HTTP
zmzai-agent run "<prompt>" [--workspace <path>] [--agent default]  # 单发跑一个任务，SSE 打到 stdout
```

CLI 用 JSONL store + FS workspace backend + OpenAI-compatible ModelProvider（env: `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`MODEL`）+ 本地子进程 SandboxExecutor。证明零 Mongo 可跑。

## 6. 迁移步骤（不破坏生产）

1. 建 `packages/agent-framework`，把 framework/core 的可独立部分搬入（git mv 保留历史），import 路径从 `@/framework/...` 改为 `@zmzai/agent-framework`（tsconfig paths 映射，仓库内联调）。
2. 把 `mongo-workspace.ts`、`server/context.ts` 的产品实现留在 `zmzai-agent/adapters/`，实现包接口。
3. 产品仓库的 `app/api/fw` 路由改为包 `createServer(deps)` + 薄包装。
4. 产品测试全绿后再考虑把包发布到 npm（或先 workspace 内 monorepo 引用）。
5. webfetch 工具：M4 spec 列了但没做，M5 一起补（标记 experimental）。

## 7. 验收

- `packages/agent-framework` 独立 `pnpm build` 产出 esm+cjs+dts。
- 一个仓库外的最小 demo（`examples/standalone/`）：`createServer({ JSONL store, OpenAI provider, subprocess sandbox, FS workspace })` → `serve` → curl 建 session、prompt、SSE 事件流完整。
- 产品 a.zmzai.cloud 全量测试 + build 不回归（证明抽包没破坏注入路径）。

## 8. 非目标（M5）

- 不发布到公共 npm registry（先仓库内可用，发布单独拍板）。
- 不做完整 TUI（CLI 只到 serve/run，不做交互式界面）。
- 不做 webfetch 的真实抓取代理（占位/禁用态即可）。
- OpenAPI 只写 HTTP+SSE 契约文档，不生成 SDK 代码（生成器后置）。
