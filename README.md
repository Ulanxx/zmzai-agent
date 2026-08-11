# Agent 使 · zmzai cloud

`a.zmzai.cloud` 是 ZMZ AI 的 Agent 编排与审计工作台。

它不只是一个聊天界面。这个仓库负责把用户任务拆成可追踪的运行记录，把工具调用变成可审批、可恢复、可审计的事件流，并在需要执行代码时把请求交给 Sandbox。

## 职责

- 创建 Workspace、Task Run、Tool Call、Proposal 和 Artifact 的持久化记录；
- 通过 Relay 调用模型，并把模型事件投影成前端可读的任务时间线；
- 将读文件、写文件、执行命令、构建等工具请求分流到不同 broker；
- 对高风险执行生成 proposal，等待用户授权后再继续；
- 调用 `z.zmzai.cloud` 的内部 Agent Runner，在受限环境里执行代码；
- 为运行恢复、租约回收、幂等请求和终端锁提供基础机制。

## 当前边界

- 仍是产品内测阶段，接口会随 `zmzai-cloud` 产品线调整；
- 工具执行以可审计和可恢复为优先，不追求无提示的全自动执行；
- Sandbox 负责隔离执行环境，Agent 只负责授权、编排、事件记录和结果呈现。

## 目录

| 路径 | 说明 |
| --- | --- |
| `app/` | Next.js 页面与服务端路由 |
| `components/agent-workbench.tsx` | Agent 工作台主界面 |
| `lib/agent-runtime.ts` | Agent 运行时入口 |
| `lib/*-tool-broker.ts` | 不同工具类型的执行与授权边界 |
| `lib/relay-agent-stream.ts` | Relay 模型流处理 |
| `lib/sandbox-*.ts` | Sandbox 内部 Runner 调用与快照 |
| `models/` | Workspace、Task Run、Tool Call、Proposal、Artifact 等模型 |
| `docs/reference/` | Relay / Sandbox 内部 API 参考 |
| `memory/` | 已修复问题和运行经验记录 |

## 本地运行

```bash
pnpm install
pnpm dev
```

常用检查：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_URL` | `http://localhost:3000` | 当前 Agent 服务地址 |
| `MONGODB_URI` | 无 | Workspace、Task Run、Tool Call 等数据存储 |
| `AUTH_SECRET` | 无 | 必须与牧之账号体系一致，用于校验 session |
| `SESSION_COOKIE_NAME` | `muzhi_session` | 登录态 cookie 名称 |
| `SESSION_COOKIE_DOMAIN` | 空 | 多子域共享登录时使用 |
| `RELAY_AGENT_URL` | `https://m.zmzai.cloud` | Relay 内部 Agent API 地址 |
| `RELAY_AGENT_SERVICE_SECRET_CURRENT` | 空 | Agent 调 Relay 的当前服务密钥 |
| `RELAY_AGENT_SERVICE_SECRET_PREVIOUS` | 空 | 密钥轮换期间的旧密钥 |
| `SANDBOX_AGENT_URL` | `https://z.zmzai.cloud` | Sandbox 内部 Agent Runner 地址 |
| `SANDBOX_AGENT_SERVICE_SECRET_CURRENT` | 空 | Agent 调 Sandbox 的服务密钥 |

## 相关仓库

- [`zmzai-relay`](https://github.com/Ulanxx/zmzai-relay)：模型目录、额度钱包与模型调用边界；
- [`zmzai-sandbox`](https://github.com/Ulanxx/zmzai-sandbox)：受限代码执行层；
- [`zmzai-db`](https://github.com/Ulanxx/zmzai-db)：共享用户、账号和 session schema。

Apache-2.0 · 牧之
