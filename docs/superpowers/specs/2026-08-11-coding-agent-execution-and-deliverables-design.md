# Coding Agent：任务级执行授权与沙箱产物交付

> 产品：`a.zmzai.cloud`。仓库：`zmzai-agent`（Agent 侧）+ `zmzai-sandbox`（执行侧）。状态：已实现（2026-08-11 本地全链路 E2E 验证通过；OpenSandbox 真实容器执行待配置 OPEN_SANDBOX_URL + python-pptx 镜像后验收）。

## 1. 目标

把 `a.zmzai.cloud` 从“只读分析 + 提案式文本修改”升级为**可交付的 Coding Agent**：Agent 在隔离沙箱中真实执行任务（写脚本、生成文件、构建、校验、迭代），并把生成的文件产物（如 `.pptx`）回传给用户下载。以“写一份 10 页 PPT”为垂直验收场景，但能力对任意“生成文件”任务通用。

## 2. 现状与缺口（已核实）

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 沙箱执行 | 已上线：`exec` 工具 → 执行提案 → 用户批准 → OpenSandbox 运行 → stdout/stderr 流式回传 → 恢复续跑 | `lib/exec-tool-broker.ts`、`lib/execution-proposals.ts`、`lib/execution-resume.ts`、`app/api/executions/[proposalId]/approve` |
| 执行审批 | 每次 `exec` 单独审批；工具结果 `terminate: true` 等批准 | `exec-tool-broker.ts:63` |
| 输出回传 | 仅文本：`sandbox.output` 事件；`execution_output` artifact（文本，≤64 KiB） | `lib/execution-resume.ts:14`（`maxArtifactBytes = 64 * 1024`） |
| 沙箱产物 | **无回传通道**：沙箱运行结束即销毁临时环境，生成文件丢弃 | `zmzai-sandbox/lib/agent-executor.ts`（`sandbox.completed` 后清理） |
| 二进制存储 | **无**：`ArtifactReference.payload` 是 JSON Mixed；Workspace 仅 UTF-8 文本（单文件 ≤512 KiB） | `models/artifact-reference.ts`、v1 规格 §5 |
| PPT 运行时 | 沙箱无 pptx 生成库；命令白名单无 `pip` | `lib/exec-tool-broker.ts:7` |
| 产物 UI | 仅有文本预览（`execution_output`），无下载入口 | `components/agent-workbench.tsx` |

结论：执行链路存在，但**产物出不来、二进制存不下、多步任务被打断**，因此“写 PPT”无法交付。

## 3. 已锁定决策

- **任务级执行授权**：用户批准一次“执行计划”后，Agent 可在该 run 内连续运行命令直到交付，不再逐步打断；每次命令仍是独立 ToolCall + Sandbox Run，完整留痕。
- **PPT 生成栈**：沙箱镜像预装 `python-pptx`，模型写 Python 脚本生成 `.pptx`。
- **本期范围**：通用执行 + 产物回传（PPT 只是验收用例）。

## 4. 非目标

- 不引入对象存储；二进制产物本期用 Mongo GridFS（v1 维持“无新基础设施”）。
- 不做 `webfetch`、浏览器自动化、MCP/连接器。
- 二进制产物不写入 Workspace 文本版本；Workspace 仍只存文本代码。产物是 run 级交付物。
- 不做产物在线编辑、多用户协作、产物版本化/对比。
- 执行授权只免除审批，**不放开**命令白名单、路径约束、资源上限、模型/轮次/工具/时间/输出预算。

## 5. 契约变更：沙箱产物回传（zmzai-sandbox）

### 5.1 产物收集

沙箱 run `succeeded` 时，收集工作目录中相对输入快照**新增或内容变化**的文件，生成产物清单。规则：

- 仅收集声明目录（默认工作目录根）下文件；路径必须规范化、相对、不可逃逸（同 v1 快照校验）。
- 上限：单文件 ≤ 20 MiB，单 run 产物总数 ≤ 50、总字节 ≤ 100 MiB；超出上限的产物跳过并在事件中标记 `too_large`。
- 清单只含元数据：`{ path, bytes, contentType, sha256 }`。

### 5.2 内部 API 扩展

```text
sandbox.completed（事件 data 增加）:
  artifacts: [{ path, bytes, contentType, sha256, tooLarge }]

GET /api/internal/agent/runs/:runId/artifacts
  -> { artifacts: [...] }                      # 服务密钥认证

GET /api/internal/agent/runs/:runId/artifacts/:path
  -> 文件体（服务密钥认证，流式；按路径白名单与大小上限校验）
```

- demo provider（未配置 OpenSandbox 时）同步模拟：生成一个示例清单，保证 Agent 集成可离线开发。
- OpenSandbox provider 需在 `runAgentSandboxCommand` 返回后，用保留的 `sandboxId` 通过沙箱文件 API 读回文件（`zmzai-sandbox/lib/opensandbox-provider.ts` 目前只保留 `stdout/stderr/exitCode`）。

### 5.3 沙箱镜像

- 构建镜像时预装 `python3 + python-pptx`（`pip install python-pptx`）。命令白名单已含 `python3`，无需运行时安装、不开放网络安装。

## 6. Agent 侧变更（zmzai-agent）

### 6.1 二进制产物模型与存储

新模型 `SandboxArtifactModel`：

```text
artifactId, runId, userId, toolCallId,
sandboxPath, contentType, sizeBytes, sha256,
gridFsFileId, tooLarge, createdAt
```

- 二进制内容存 Mongo GridFS（`GridFSBucket`，chunk 255 KiB）；文档记录元数据。
- 单 run 总产物上限（如 100 MiB）在拉取阶段强制执行；超限不落库，发 `artifact.upsert` 时标记 `tooLarge: true`。
- 事件流与审计只存元数据，**二进制永不进 TaskEvent / ArtifactReference.payload**。

### 6.2 下载端点

```text
GET /api/runs/:runId/artifacts/:artifactId/download
  - userId + runId 鉴权；不存在或非本人 -> 404（不泄露存在性）
  - 响应：GridFS 流式 + Content-Disposition: attachment（filename 用 sandboxPath 基名）
  - 审计页/工作台产物面板可跳转下载
```

### 6.3 任务级执行授权

新模型 `ExecutionGrantModel`：

```text
grantId, runId, workspaceId, userId,
createdAt, expiresAt, remainingCommands, remainingWallTimeMs,
revokedAt, 由哪个 exec 提案批准创建（sourceProposalId）
```

流程：

1. `exec` 工具首次调用（或 run 尚无 grant 时）：照旧生成执行提案并 `waiting_approval`（快照、命令、资源上限即“执行计划”）。
2. 用户批准该执行提案 → 创建 `ExecutionGrant`（默认剩余 20 条命令 / 累计墙钟 10 分钟，与 TaskRun 预算对齐）→ 恢复 Agent。
3. grant 有效期内后续 `exec` 调用：校验命令在白名单、预算内 → **直接运行**（`tool.requested → sandbox → tool.completed`），run 保持 `running`，不再打断。
4. grant 用尽 / 过期 / 任务取消 / 服务重启恢复：耗尽则回到“需再审批”；取消则 `revokedAt`；重启后 grant 持久化可恢复，恢复逻辑复用 `lib/execution-resume.ts` / `lib/lease-recovery.ts` 模式。
5. 每条命令仍落独立 ToolCall、独立 Sandbox Run、独立产物，审计页与工具时间线不回归。

### 6.4 exec 工具行为

- 有有效 grant：不 `terminate`，直接执行并返回真实结果（含产物清单摘要）。
- 无 grant：维持现状（生成执行计划提案、`terminate: true` 等批准）。
- `exec` 结果中加入 `artifacts` 摘要（路径 + 字节数），让模型知道交付物存在并决定是否校验/迭代。

## 7. UI

- 工作台画布“产物”视图与审计页“关联产物”：
  - `binary_file` 类型显示文件名、类型、大小、sha256 摘要；点击出现**下载**按钮（走 §6.2 端点）。
  - 文本类 artifact（`execution_output`、`file_preview`）保持现状预览。
- 执行授权状态：`waiting_approval` 阶段画布展示执行计划（快照文件清单 + 命令 + 资源上限），批准文案改为“批准并授权本任务执行”。
- 运行中授权态：画布显示“执行授权中 · 剩余 N 条命令 / X 分钟”，可随时停止任务（=撤销授权）。

## 8. PPT 垂直验收路径（端到端）

```text
1. 用户：Build 模式，任务“写一份 10 页季度汇报 PPT”
2. Agent 写 gen_ppt.py（python-pptx）→ write/edit 提案
3. 用户批准文件提案 → Workspace 含脚本
4. Agent 调 exec python3 gen_ppt.py → 生成执行计划提案（快照含脚本）
5. 用户批准执行计划 → 创建任务级授权
6. Agent 连续执行：生成 → exec "unzip -t out.pptx" 自检 → 修脚本 → 再生成
7. sandbox.completed 带产物清单 → Agent 拉取 .pptx 入 GridFS → artifact.upsert(binary_file)
8. 产物面板出现 quarterly.pptx → 用户下载 → 本地打开验证无损坏
9. 可选：gen_ppt.py 保留为 Workspace 资产，下次任务复用
```

验收：上述 1–8 全流程在测试与生产各跑通一次；下载的 `.pptx` 可用办公软件打开。

## 9. 安全与边界

- 产物只回传沙箱声明清单内文件；路径、大小、数量上限在**沙箱侧强制**，Agent 侧二次校验。
- 下载端点按 `userId + runId` 鉴权，404 不泄露存在性；`Content-Disposition: attachment` 防 XSS 渲染。
- 二进制不入事件/审计/日志；GridFS 文件随 run 清理（run 删除时级联删 chunk）。
- 执行授权不改变任何既有安全边界：命令白名单、快照路径校验、资源上限、模型/轮次/工具/时间/输出预算照旧。
- 服务密钥（`SANDBOX_AGENT_SERVICE_SECRET_*`）只在服务端持有；产物回传同样走服务认证，不暴露给浏览器直连沙箱。

## 10. 数据模型与接口汇总

| 仓库 | 变更 |
| --- | --- |
| zmzai-sandbox | `agent-executor.ts` 收集产物清单；新增 `GET /api/internal/agent/runs/:runId/artifacts(/:path)`；`opensandbox-provider.ts` 支持文件读回；demo provider 模拟；镜像预装 python-pptx |
| zmzai-agent | 新 `SandboxArtifactModel` + GridFS 存储/清理；`GET /api/runs/:runId/artifacts/:artifactId/download`；新 `ExecutionGrantModel`；`exec-tool-broker.ts` 授权分支；`execution-resume.ts` 拉取产物；工作台/审计页产物面板与下载 |
| 契约 | `sandbox.completed` 事件 data 增加 `artifacts` 字段（向后兼容：旧沙箱返回空数组） |

## 11. 实施顺序

1. **沙箱侧**：OpenSandbox provider 文件读回 → 产物清单 + 拉取端点 + demo 模拟 → 镜像预装 python-pptx（独立发布，契约向后兼容，不影响 Agent 存量）。
2. **Agent 侧存储**：`SandboxArtifactModel` + GridFS + 下载端点 + 鉴权/清理单元测试。
3. **执行授权**：`ExecutionGrantModel` + exec 工具授权分支 + 恢复逻辑 + 路由/审批测试。
4. **产物回传接线**：`execution-resume.ts` 在沙箱成功后拉取清单入库并发 `artifact.upsert`；审计与工作台展示下载。
5. **PPT 验收**：镜像 + 全流程 E2E；写 PPT → 下载打开验证。
6. **加固**：大小/数量上限、GridFS 清理、授权预算耗尽与重启恢复演练、审计页不泄露二进制。

## 12. 验收标准

- 任意“生成文件”任务（PPT 为首个用例）可从沙箱交付可下载的二进制产物。
- 任务级授权下多步执行不打断；每条命令独立留痕；取消/重启后状态可恢复且不重复副作用。
- 下载端点跨用户 404；二进制不出现在事件流、审计与日志。
- 既有 Plan/Build、提案审批、事件回放、运行审计全部不回归。


## 13. 实现状态（2026-08-11）

- 沙箱侧：`agent-executor.ts` 成功后收集产物清单（相对快照新增/变化，≤20 MiB/文件、50 个、100 MiB）；`GET /api/internal/agent/runs/:runId/artifacts(/:path)` 已上线（服务密钥认证、路径白名单、404 不泄露）；demo provider 生成 `demo-output.txt` 示例产物；`docker/agent-python.Dockerfile` 预装 python-pptx。
- Agent 侧：`SandboxArtifactModel` + GridFS 存储（`lib/artifact-storage.ts`）；`GET /api/runs/:runId/artifacts/:artifactId/download`（跨用户 404 已验证）；`ExecutionGrantModel`（批准执行提案创建，默认 20 条/10 分钟，取消/租约恢复撤销）；exec 工具授权分支直接运行并返回产物摘要；`lib/sandbox-execution.ts` 统一「运行+事件+产物入库+`binary_file` upsert」。
- UI：`binary_file` 产物画布（类型/大小/SHA-256 + 下载按钮）；运行头「执行授权中」状态；任务画布授权预算行；执行提案文案「批准并授权执行」。
- 本地 E2E 已验证：Build → exec 提案 → 批准（生成 grant）→ 5 条命令直接执行不打断 → 每次命令产物入 GridFS → 下载端点 200 + 跨用户 404 → `succeeded`。
