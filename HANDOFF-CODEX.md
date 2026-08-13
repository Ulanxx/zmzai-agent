# HANDOFF — 给 Codex 的交接文档

> 日期：2026-08-12。作者：ZCode（上一轮实现者）。
> 产品：`a.zmzai.cloud`（zmzai-agent 仓库）。任务：用 PI（@earendil-works/pi-agent-core）实现 OpenCode 式 Agent 框架。
> 目标：让 Codex 从当前状态无缝继续。**先读本文件 + spec，再动代码。**

## 0. 一句话现状

框架 M0–M5 已全部实现并大部分上生产：a.zmzai.cloud 跑的是新框架（plan/build 已下线）；M5 把框架抽成了独立包 `packages/agent-framework`（@zmzai/agent-framework）。**当前有一批 M5 改动未提交（39 个文件），且用户要求后续发布 npm。**

## 1. 仓库布局

```
zmzai-agent/（git 仓库，main 分支，remote: Ulanxx/zmzai-agent，push 触发 GitHub Actions 自动部署到香港服务器 a.zmzai.cloud）
├── app/                    # Next.js App Router（/fw 工作台、/audit 审计、/api/fw/*、/api/audit/*）
├── framework/              # 产品侧兼容层：Mongo 实现 + 包 re-export（薄壳）
│   ├── core/session/       #   mongo-models.ts, mongo-store.ts（产品实现）
│   ├── core/events/        #   mongo-models.ts, mongo-event-log.ts（EventLog 实现）, bus.ts（旧函数名兼容层）
│   ├── core/tools/         #   mongo-workspace.ts（产品 WorkspaceFiles 实现）
│   ├── core/runtime/       #   runner.ts（re-export 包 + defaultStore）
│   └── server/context.ts   #   【产品组装点】SessionRunner 注入 Mongo+relay+OpenSandbox
├── packages/agent-framework/   # 【M5 产物】@zmzai/agent-framework 独立包
│   ├── src/core/           #   框架核心（session/events/permission/agent/tools/runtime）全适配器化
│   ├── src/adapters/       #   5 个注入接口 + 参考实现（jsonl/fs/subprocess-sandbox/openai-provider）
│   ├── src/server/create-server.ts  # createServer(deps) 组装入口
│   ├── src/cli.ts          #   bin: zmzai-agent serve/run
│   ├── openapi.yaml        #   HTTP + SSE 契约
│   ├── examples/standalone.mjs      #   第三方演示
│   └── dist/               #   构建产物（已 .gitignore）
├── lib/                    # 共享产品库（sandbox-execution/sandbox-snapshot/workspace-edit/relay-agent-stream 等）
├── models/                 # 共享 mongoose 模型（workspace/workspace-file/workspace-revision/sandbox-artifact）
├── instrumentation.ts      #   Framework lease-recovery 启动（用包 startLeaseRecovery）
├── docs/superpowers/specs/2026-08-11-pi-agent-framework-v0-design.md     # 【主 spec：M1-M5 全记录】
├── docs/superpowers/specs/2026-08-11-pi-agent-framework-m5-packaging-design.md  # M5 设计
└── docs/superpowers/plans/2026-08-11-fw-protocol-acceptance.md           # 生产验收清单
```

## 2. 已完成（M1–M5）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M1 骨架** | Session/Message/Part wire 类型、Mongo store、EventLog、权限引擎（ruleset last-match-wins + once/always/reject + always 持久化） | ✅ 上生产 |
| **M2 Runner** | SessionRunner（PI 适配层）、7 内置工具（read/glob/grep/write/edit/bash/todo）、agent presets（default/readonly/explore/general）、HTTP 路由 | ✅ 上生产 |
| **M3 产品切换** | /fw 工作台（parts 渲染、内联审批、todo、产物预览）、旧 plan/build 全下线（30+ 文件删除）、审计页重写为 FW 事件源、lease-recovery | ✅ 上生产（commit ea5f65d） |
| **M4 框架化** | task 子代理、.zmzai/agents/*.md 自定义 agent、compaction、JSONL store | ✅ 上生产（commit 3b73bcf + 2 个 parentId 修复） |
| **M5 抽包** | packages/agent-framework 独立包、5 注入接口、createServer、CLI、OpenAPI、examples | ✅ 代码级完成，**未提交未部署** |

## 3. 当前未提交改动（39 文件）— Codex 接手第一件事

`git status` 显示 39 个未提交文件，全是 M5。**必须先提交，否则产品无法部署 M5**：

- 新增：`packages/`（整个包）、`framework/core/events/mongo-event-log.ts`、M5 spec
- 修改/删除：`framework/core/*` 大量纯模块删除（改由包提供）+ 产品兼容层改造
- 关键文件已改：`framework/server/context.ts`（产品组装点）、`instrumentation.ts`（lease-recovery 接线）、`tsconfig.json`/`vitest.config.mts`/`next.config.ts`（alias 指向包源码）、`pnpm-workspace.yaml`（声明 packages/*）

**提交前验证**（本地已全绿，放心提交）：
```bash
npm test                # 114 通过（产品）
cd packages/agent-framework && npx vitest run   # 77 通过（包）
npx tsc --noEmit        # 干净
npx next build          # 成功，路由齐全
```

**提交后**：push main → GitHub Actions 自动部署到 a.zmzai.cloud（香港 self-hosted runner）。产品行为不变（路由/前端零改动，只改内部 import），但建议按验收清单跑一遍生产冒烟。

## 4. 待办清单（按优先级）

### P0 — 提交 M5 并部署（用户等待中）
1. commit M5（message 建议：`feat: extract framework into @zmzai/agent-framework package (M5)`）
2. push main，盯 Actions（quality + deploy）
3. 生产冒烟：`/fw` 200、`/`→307、旧路由 404（对照 docs/superpowers/plans/2026-08-11-fw-protocol-acceptance.md）

### P1 — 发布 npm（用户明确要求，见 memory publish-npm-pending）
- `@zmzai/agent-framework` 发布到公共 npm。当前 version 0.1.0。
- 前置：npm 账号/token（.npmrc）、`npm run build` 产出 dist、`files: ["dist","openapi.yaml"]` 已配好、package.json `bin` 已配
- 建议流程：`npm publish --access public`；可选 git tag + GitHub Release
- ⚠️ 注意：包目前 `dependencies` 含 `@earendil-works/pi-agent-core@0.84.1`（私有 scoped，需确认可被 npm 解析或改成 peerDependencies）

### P2 — 框架遗留（spec §11.1 记录，非阻塞）
- **title 异步生成**：`streamOneText` 已就绪（compaction.ts），未接 runner（session 创建后便宜模型生成标题）
- **webfetch 工具**：spec 列了但没实现（标记 experimental 即可，或直接实现）
- **JSONL 后端的 workspace facade**：FW_MODE=local 时 session 用 JSONL，但 workspace 仍走 Mongo（包已带 createFsWorkspaceFiles，产品未接 local 模式）
- **子代理嵌套端到端单测**：单进程双 PI 循环时序脆弱，只验证了确定性前置；嵌套完成路径靠生产真模型验证过
- **完整 TUI**：spec 非目标（只有 CLI serve/run）

### P3 — 生产数据清理（可选，需用户确认）
- 旧协议 8 个 collection（TaskRun/TaskEvent/ChangeProposal/ExecutionProposal/ExecutionGrant/ToolCall/ArtifactReference/AgentSession）代码已删，生产 Mongo 数据保留未 drop（可回退）。确认无价值后可手动 drop
- 生产有 3 个测试 fw session + 1 个 GridFS 产物残留（M3/M4 验收留下）

## 5. 关键架构决策（避免 Codex 踩坑）

1. **适配器注入**：框架包零产品依赖。5 接口 = ModelProvider / SandboxExecutor / LeaseStore / EventLog / WorkspaceFiles。产品在 `framework/server/context.ts` 注入 Mongo+relay+OpenSandbox 实现；包自带 JSONL/FS/subprocess/OpenAI 参考实现。
2. **包 ESM 构建**：用 `module: NodeNext` + 相对 import 带 `.js` 扩展名（否则 dist 无法被 node import）。产品 tsconfig paths + vitest alias + next.config webpack `extensionAlias` 都指向**包源码**（不是 dist），三者必须同步改。
3. **EventLog**：包定义接口，`createMemoryEventLog` 是内存实现；产品 `mongo-event-log.ts` 是 Mongo 实现（seq 计数 + fw_events collection）。`notifyEventLogListeners` 做进程内 SSE fan-out。
4. **runner 必填 deps**：`eventLog` + `workspaceFor` 必填；`sandbox`/`leaseStore` 可选（默认 noop）。
5. **生产组装**：`getFrameworkRunner()` 是单例（globalThis 防 HMR），注入 streamFnFor（按 userId 绑 relay 计费）+ compaction（relay 模型摘要，contextWindow 128k）。
6. **权限唯一插入点**：PI `beforeToolCall`。审批 once/always/reject 经 `PermissionEngine`，always 固化到 session.permission。
7. **mongoose immutable 坑**（M4 踩过）：`parentId` 标了 immutable，只能创建时写入，不能 updateSession 补——子代理创建子会话时用 createFrameworkSession 的 parentId 参数一次写入。

## 6. 测试地图

```
产品（npm test，114）：
  framework/core/session/mongo-store.test.ts    # Mongo SessionStore（含 parentId 持久化回归）
  framework/core/events/bus.test.ts             # 兼容层 publishFrameworkEvent（mongo mock）
  其余 15 个文件：lib/ models/ 共享库测试
包（cd packages/agent-framework && npx vitest run，77）：
  core/permission/{ruleset,engine}.test.ts      # 权限引擎
  core/agent/{loader,registry}.test.ts          # 自定义 agent + presets
  core/session/jsonl-store.test.ts              # JSONL store
  core/events/bus.test.ts（包内）                # EventLog 接口 + 内存实现
  core/tools/{adapter,builtins}.test.ts         # 工具
  core/runtime/{runner,compaction}.test.ts      # runner 集成（faux provider）+ compaction
```

## 7. 用户上下文（重要）

- 用户是 zmzai 创始人（mu.zhi@yingdao.com），中文沟通，关注"框架能独立分发"。
- 已确认决策：session 强绑 workspace、子代理继承父 workspaceId、title 便宜模型异步生成、运行中输入 FIFO 排队（全部在 spec §13）。
- **用户要求后续提醒发布 npm**（已记 memory：publish-npm-pending）。
- 生产部署 = push main 自动触发；验收方法 = HK 服务器 SSH（root@149.88.84.189）+ mongosh 铸造 30 分钟测试 session（见 memory hk-server-ssh + 验收清单）。
- 上一轮对话结束时我问过"commit + push M5？"，用户转交给 Codex——**所以提交部署 M5 是当前最优先，用户期待 Codex 接手**。

## 8. 下一步建议（Codex 接手顺序）

1. 读本文件 + `docs/superpowers/specs/2026-08-11-pi-agent-framework-v0-design.md`（§11.1 实现状态）
2. `git status` 核对 39 文件 → commit M5 → push（盯 Actions）
3. 生产冒烟（对照验收清单）
4. 处理 P1 npm 发布（先确认 pi-agent-core 依赖可解析；询问用户 registry 配置）
5. 问用户 P3 是否清理旧 collection
6. 有疑问找 ZCode 的 memory：`/Users/ulanxx/.zcode/cli/memories/projects/zmzai-7a5fdbd75a13cbb4/memory/`（pi-opencode-framework.md 最全）
