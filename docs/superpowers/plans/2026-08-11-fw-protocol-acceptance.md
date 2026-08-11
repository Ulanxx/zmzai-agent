# a.zmzai.cloud FW 协议真机验收清单

> 目标：在真实依赖（Mongo + Relay 模型 + OpenSandbox）下验证 M1–M3 交付的 FW 协议端到端成立。以"写 10 页 PPT"为垂直场景。
> 前置：部署环境具备 `.env.local`（`MONGODB_URI`、`AUTH_SECRET`、`RELAY_AGENT_SERVICE_SECRET_CURRENT`、`SANDBOX_AGENT_SERVICE_SECRET_CURRENT`），且沙箱镜像已预装 `python-pptx`（见 2026-08-11-coding-agent spec §5.3）。

## 0. 冒烟：服务起得来

```bash
curl -s https://a.zmzai.cloud/fw            # 200，返回工作台 HTML
curl -s https://a.zmzai.cloud/              # 307/308 → /fw（默认切换生效）
curl -s https://a.zmzai.cloud/api/fw/agents # 401（未登录）或 agents 列表
```

## 1. 会话生命周期（FW 协议）

```bash
# 登录态 cookie 记为 $COOKIE（auth.zmzai.cloud SSO）
WID=<已存在的 workspaceId>

# 1.1 创建会话并立即跑第一个 prompt
curl -s -X POST https://a.zmzai.cloud/api/fw/sessions \
  -H "cookie: $COOKIE" -H "content-type: application/json" \
  -d "{\"workspaceId\":\"$WID\",\"model\":{\"providerId\":\"relay\",\"modelId\":\"<模型>\"},\"prompt\":\"列出当前 workspace 的文件\"}"
# → 201 { session: { id: "ses_...", ... } }

SID=<返回的 session id>

# 1.2 读会话（messages + parts 投影）
curl -s https://a.zmzai.cloud/api/fw/sessions/$SID -H "cookie: $COOKIE"
# → session + messages[]；assistant 消息含 step-start/text/step-finish parts

# 1.3 SSE 事件流（另开终端，应看到 session.status / message.part.* 事件）
curl -N https://a.zmzai.cloud/api/fw/sessions/$SID/events -H "cookie: $COOKIE"
```

## 2. 权限引擎（内联审批）

```bash
# 2.1 发一个触发 bash 的任务
curl -s -X POST https://a.zmzai.cloud/api/fw/sessions/$SID/prompt \
  -H "cookie: $COOKIE" -H "content-type: application/json" \
  -d '{"text":"用 bash 运行 ls 看看目录"}'
# → 202 { accepted: true, queued: false }
# SSE 流应出现 session.status:waiting_permission + permission.asked（permission:bash）

# 2.2 拒绝 → Agent 应收到反馈且不执行
RID=<permission.asked 里的 request.id>
curl -s -X POST https://a.zmzai.cloud/api/fw/sessions/$SID/permissions/$RID \
  -H "cookie: $COOKIE" -H "content-type: application/json" \
  -d '{"reply":"reject","feedback":"先别跑"}'
# → { resolved: true }；SSE 出现 permission.replied + tool part status:error

# 2.3 再发一次，选 always → 后续 bash 不再询问
# （验证 always 固化到 session.permission，同类命令直接执行）
```

## 3. PPT 垂直场景（spec §8 验收路径）

```bash
curl -s -X POST https://a.zmzai.cloud/api/fw/sessions \
  -H "cookie: $COOKIE" -H "content-type: application/json" \
  -d "{\"workspaceId\":\"$WID\",\"model\":{\"providerId\":\"relay\",\"modelId\":\"<模型>\"},\"prompt\":\"写一份 10 页季度汇报 PPT，用 python-pptx 生成 quarterly.pptx\"}"
```

预期（对照 SSE 流 + 工作台 UI）：
1. todo.updated 出现任务清单（拆解步骤）
2. write 工具写 gen_ppt.py → file.edited 事件（含 diff）→ 工作台"改动"tab 有差异卡
3. bash 执行 `python3 gen_ppt.py` → 首次 permission.asked → 批准后 artifact.created（quarterly.pptx）
4. 产物卡出现在"产物"tab，可点击预览（若 html/图片）或下载

```bash
# 3.1 下载产物验证无损
AID=<artifact.created 的 artifactId>
curl -s -o /tmp/q.pptx https://a.zmzai.cloud/api/fw/sessions/$SID/artifacts/$AID/download -H "cookie: $COOKIE"
file /tmp/q.pptx   # → Microsoft PowerPoint / Zip archive
# 用办公软件打开 /tmp/q.pptx 确认 10 页无损坏
```

## 4. 排队与恢复

```bash
# 4.1 运行中再发一条 → 202 { queued: true }，会话详情 queuedPrompts 有 1 条
# 4.2 当前 run 结束后自动续跑第二条（SSE 可见新一轮 message.* 事件）
# 4.3 abort：POST /api/fw/sessions/$SID/abort → 清空队列 + 停止当前 run
```

## 5. 审计页

```bash
curl -s https://a.zmzai.cloud/api/audit/sessions -H "cookie: $COOKIE"          # 会话清单 + 工具计数
curl -s https://a.zmzai.cloud/api/audit/sessions/$SID -H "cookie: $COOKIE"     # 工具时间线 + 事件流
curl -s https://a.zmzai.cloud/audit -H "cookie: $COOKIE"                        # 审计页 HTML
```

## 验收通过标准

- 以上 0–5 全部跑通，PPT 下载可打开
- 旧协议路由（/api/runs、/api/proposals、/legacy、/s/）全部 404
- 全程无 plan/build toggle；文件改动无需审批直接落版本，bash 首次审批后授权内不再打断
