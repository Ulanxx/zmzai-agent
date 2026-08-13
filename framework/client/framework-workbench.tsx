"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Icon } from "@/components/icon";
import { Seal } from "@/components/seal";
import {
  fwApi,
  useFrameworkSession,
  type ArtifactCard,
  type Reply,
  type SessionInfo,
} from "@/framework/client/use-framework-session";
import { ArtifactPreviewCard, EditCard, groupAssistantMessages, MessageView, PermissionCard, TodoChecklist } from "@/framework/client/parts";

type Model = { model: string; maxOutputTokens: number };
type Workspace = { id: string; name: string; defaultModel: string };

type CanvasTab = "artifacts" | "edits";

type WorkspaceSummary = Workspace;

async function fetchList<T>(url: string, key: string): Promise<T[]> {
  const response = await fetch(url, { cache: "no-store" });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : "请求失败，请先确认服务和登录状态";
    throw new Error(message);
  }
  const value = body?.[key];
  if (!Array.isArray(value)) throw new Error(`接口响应缺少 ${key} 列表`);
  return value as T[];
}

export function FrameworkWorkbench({ sessionId }: { sessionId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const { snapshot, live, loading, loadError } = useFrameworkSession(sessionId);
  const [models, setModels] = useState<Model[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [sending, setSending] = useState(false);
  const [replying, setReplying] = useState(false);
  const [canvasTab, setCanvasTab] = useState<CanvasTab>("artifacts");
  const [preview, setPreview] = useState<ArtifactCard | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
  const [creatingWs, setCreatingWs] = useState(false);
  // 窄屏下 sidebar 可收起（按钮仅在 48rem 以下显示）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Workspace 重命名/删除（F2）：重命名内联编辑，删除需二次确认。
  const [renamingWs, setRenamingWs] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");
  const [confirmDeleteWs, setConfirmDeleteWs] = useState<string | null>(null);
  // G3 会话搜索。
  const [sessionQuery, setSessionQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [followScroll, setFollowScroll] = useState(true);
  // 会话列表请求序号：快速切换 Workspace 时丢弃过期响应，避免旧列表覆盖新列表。
  const sessionsReqSeq = useRef(0);

  const busy = live.status !== "idle";
  const queuedCount = snapshot?.session.queuedPrompts.length ?? 0;

  // 当前登录用户（header 展示 + 退出）。
  useEffect(() => {
    void fetch("/api/fw/me", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ user: { name: string; email: string } }>) : null))
      .then((body) => setUser(body?.user ?? null))
      .catch(() => setUser(null));
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/fw/logout", { method: "POST" }).catch(() => undefined);
    router.push("/fw");
    router.refresh();
  }, [router]);

  const createWorkspace = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name || !model) return;
    setCreatingWs(false);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ name, description: "", defaultModel: model }),
      });
      const body = (await response.json()) as { workspace?: WorkspaceSummary; error?: string };
      if (!response.ok) throw new Error(body.error ?? "创建失败");
      if (body.workspace) {
        setWorkspaces((current) => [body.workspace!, ...current]);
        setWorkspaceId(body.workspace.id);
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "创建 Workspace 失败");
    }
  }, [model]);

  const renameWorkspace = useCallback(async (id: string) => {
    const name = renamingName.trim();
    if (!name) {
      setRenamingWs(null);
      return;
    }
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await response.json()) as { workspace?: WorkspaceSummary; error?: string };
      if (!response.ok) throw new Error(body.error ?? "重命名失败");
      if (body.workspace) setWorkspaces((current) => current.map((item) => (item.id === id ? body.workspace! : item)));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "重命名失败");
    } finally {
      setRenamingWs(null);
    }
  }, [renamingName]);

  const removeWorkspace = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("删除失败");
      setWorkspaces((current) => current.filter((item) => item.id !== id));
      setWorkspaceId((current) => (current === id ? null : current));
      setSessions([]);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setConfirmDeleteWs(null);
    }
  }, []);

  // Bootstrap: agents, models, workspaces, and this workspace's session list.
  useEffect(() => {
    void (async () => {
      const [modelResult, workspaceResult] = await Promise.allSettled([
        fetchList<Model>("/api/models", "models"),
        fetchList<WorkspaceSummary>("/api/workspaces", "workspaces"),
      ]);
      if (modelResult.status === "fulfilled") setModels(modelResult.value);
      if (workspaceResult.status === "fulfilled") {
        setWorkspaces(workspaceResult.value);
        const first = workspaceResult.value[0];
        if (first) setWorkspaceId((current) => current ?? first.id);
      } else {
        setActionError(workspaceResult.reason instanceof Error ? workspaceResult.reason.message : "无法加载智能体列表");
      }
    })();
  }, []);

  // Align workspace with the loaded session, then list its sessions. The
  // setState calls are deferred so the effect body stays free of sync updates.
  useEffect(() => {
    const id = snapshot?.session.workspaceId;
    if (id) queueMicrotask(() => setWorkspaceId(id));
  }, [snapshot?.session.workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const seq = ++sessionsReqSeq.current;
    void fwApi.listSessions(workspaceId)
      .then((result) => {
        if (seq !== sessionsReqSeq.current) return; // 已切换 Workspace，丢弃过期响应
        setSessions(result.sessions);
      })
      .catch(() => undefined);
  }, [workspaceId, snapshot?.session.time.updated]);  

  // Initialize the model once models/workspace are known. Works for BOTH a new
  // session (no snapshot yet — was broken before: model stayed "" so send()
  // silently no-oped) and an existing session (restore its pinned model).
  useEffect(() => {
    if (!models.length || model) return;
    queueMicrotask(() => {
      const workspace = workspaces.find((item) => item.id === workspaceId);
      const initial = snapshot?.session.model.modelId || workspace?.defaultModel || models[0]?.model || "";
      if (initial) setModel(initial);
    });
  }, [snapshot, models, workspaces, model, workspaceId]);

  // Auto-scroll the conversation while following.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && followScroll) element.scrollTop = element.scrollHeight;
  }, [snapshot?.messages, live.todos, followScroll]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setActionError(null);

    // No session yet: create one bound to the workspace (§13.1), carrying the
    // first prompt so the runner starts immediately.
    if (!snapshot) {
      if (!workspaceId || !model) return;
      setSending(true);
      try {
        const result = await fwApi.createSession({ workspaceId, model: { providerId: "relay", modelId: model }, prompt: text });
        setPrompt("");
        router.push(`/fw/s/${result.session.id}`);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "无法创建会话");
      } finally {
        setSending(false);
      }
      return;
    }

    setSending(true);
    try {
      await fwApi.prompt(snapshot.session.id, { text });
      setPrompt("");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      setSending(false);
    }
  }, [prompt, sending, snapshot, workspaceId, model, router]);

  const replyPermission = useCallback(
    async (reply: Reply, feedback?: string) => {
      if (!snapshot || !live.pendingPermission || replying) return;
      setReplying(true);
      try {
        await fwApi.replyPermission(snapshot.session.id, live.pendingPermission.id, reply, feedback);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "审批操作失败");
      } finally {
        setReplying(false);
      }
    },
    [snapshot, live.pendingPermission, replying],
  );

  const stop = useCallback(async () => {
    if (!snapshot) return;
    await fwApi.abort(snapshot.session.id).catch(() => undefined);
  }, [snapshot]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const openArtifact = useCallback((artifact: ArtifactCard) => {
    setPreview(artifact);
    setCanvasTab("artifacts");
  }, []);

  const sourceMessages = snapshot?.messages;
  const messages = useMemo(() => groupAssistantMessages(sourceMessages ?? []), [sourceMessages]);
  const taskTools = useMemo(
    () => (sourceMessages ?? []).flatMap((entry) => entry.parts.filter((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool")),
    [sourceMessages],
  );

  // 仅首次加载（无快照）时显示全屏 loading；会话切换时保留旧内容直到新快照到达，
  // 避免 /fw → /fw/s/:id 或会话间切换整页闪烁。
  if (loading && !snapshot) return <main className="workbench-loading">正在建立工作台…</main>;
  if (loadError) return <main className="workbench-loading">{loadError}</main>;

  return (
    <main className="workbench fw-workbench">
      <header className="workbench-header">
        <div className="flex items-center gap-3">
          <Seal size={26} className="agent-seal" />
          <span className="font-mono text-sm font-bold tracking-[0.08em]">ZMZAI AGENT</span>
        </div>
        <nav className="workbench-nav" aria-label="主导航">
          {sessionId && (
            <Link href="/fw" className="fw-back-link" title="返回工作台">
              ← 返回
            </Link>
          )}
          <Link href="/fw" className={pathname === "/fw" ? "active" : ""}>新任务</Link>
          <Link href="/audit" className={pathname === "/audit" ? "active" : ""}>运行审计</Link>
        </nav>
        <div className="workbench-status">
          {user && (
            <span className="fw-user" title={user.email}>
              {user.name}
            </span>
          )}
          <button type="button" className="icon-command" title="退出登录" onClick={() => void logout()}>
            <Icon name="logout" size={14} />
          </button>
          <span className="status-dot" />
          AGENT <span className="header-domain">a.zmzai.cloud</span>
        </div>
      </header>
      {actionError && (
        <div className="workbench-alert">
          {actionError}
          {actionError === "请先登录" &&
            (process.env.NODE_ENV === "development" ? (
              <a href="/dev/login">本地登录</a>
            ) : (
              <a href="https://auth.zmzai.cloud/login">去登录</a>
            ))}
        </div>
      )}

      <div className="fw-grid">
        <aside className={sidebarCollapsed ? "fw-sidebar collapsed" : "fw-sidebar"}>
          <div className="pane-heading">
            <button type="button" className="icon-command fw-sidebar-toggle" title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCollapsed((value) => !value)}>
              <Icon name={sidebarCollapsed ? "chevron-down" : "cross"} size={14} />
            </button>
            <span>智能体</span>
            <button type="button" className="icon-command" title="新建 Workspace" onClick={() => setCreatingWs((value) => !value)}>
              <Icon name="plus" />
            </button>
          </div>
          {creatingWs && (
            <form
              className="workspace-create"
              onSubmit={(event) => {
                event.preventDefault();
                void createWorkspace(event);
              }}
            >
              <input name="name" autoFocus maxLength={120} placeholder="智能体名称" />
              <button type="submit">创建</button>
            </form>
          )}
          <nav className="workspace-list" aria-label="Workspace 列表">
            {workspaces.map((item) => (
              <div key={item.id} className={item.id === workspaceId ? "workspace-item-wrap active" : "workspace-item-wrap"}>
                {renamingWs === item.id ? (
                  <form
                    className="workspace-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void renameWorkspace(item.id);
                    }}
                  >
                    <input value={renamingName} onChange={(event) => setRenamingName(event.target.value)} autoFocus maxLength={120} aria-label="智能体名称" />
                    <button type="submit" className="icon-command" title="保存">
                      <Icon name="check" />
                    </button>
                  </form>
                ) : (
                  <button type="button" className="workspace-item" onClick={() => setWorkspaceId(item.id)}>
                    <span>{item.name}</span>
                  </button>
                )}
                <div className="workspace-item-actions">
                  <button
                    type="button"
                    className="icon-command"
                    title="配置智能体"
                    onClick={() => router.push(`/fw/w/${item.id}`)}
                  >
                    <Icon name="settings" size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon-command"
                    title="重命名"
                    onClick={() => {
                      setRenamingWs(item.id);
                      setRenamingName(item.name);
                      setConfirmDeleteWs(null);
                    }}
                  >
                    <Icon name="edit" size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon-command danger"
                    title={confirmDeleteWs === item.id ? "确认删除" : "删除"}
                    onClick={() => setConfirmDeleteWs(confirmDeleteWs === item.id ? null : item.id)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
                {confirmDeleteWs === item.id && (
                  <div className="workspace-delete-confirm">
                    <span>删除后会话、产物、文件版本全部清除，不可恢复。</span>
                    <div>
                      <button type="button" onClick={() => void removeWorkspace(item.id)}>
                        确认删除
                      </button>
                      <button type="button" onClick={() => setConfirmDeleteWs(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </nav>
          <section className="run-history">
            <div className="pane-heading">
              <span>任务</span>
              <small>{sessions.length}</small>
            </div>
            {sessions.length > 5 && (
              <input
                className="fw-session-search"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="搜索会话"
                aria-label="搜索会话"
              />
            )}
            <nav className="run-history-list" aria-label="会话列表">
              {sessions
                .filter((item) => !sessionQuery.trim() || item.title.toLowerCase().includes(sessionQuery.trim().toLowerCase()) || item.agent.toLowerCase().includes(sessionQuery.trim().toLowerCase()))
                .map((item) => (
                <button type="button" key={item.id} className={item.id === sessionId ? "run-history-item active" : "run-history-item"} onClick={() => router.push(`/fw/s/${item.id}`)}>
                  <strong>{item.title}</strong>
                  <small>{item.agent}</small>
                </button>
              ))}
              {!sessions.length && <p className="empty-state">此智能体还没有任务。</p>}
              {sessions.length > 0 && sessions.filter((item) => !sessionQuery.trim() || item.title.toLowerCase().includes(sessionQuery.trim().toLowerCase())).length === 0 && <p className="empty-state">没有匹配的会话。</p>}
            </nav>
          </section>
        </aside>

        <section className="fw-conversation">
          <div className="run-toolbar">
            <div>
              <span className="eyebrow">会话</span>
              <h1>{snapshot?.session.title ?? "新任务"}</h1>
            </div>
            <div className="run-toolbar-meta">
              <span className={`run-phase ${live.status === "idle" ? "succeeded" : "running"}`}>{live.status === "idle" ? "空闲" : live.status === "waiting_permission" ? "等待审批" : "进行中"}</span>
              {live.streamState === "live" && busy && <span className="stream-state live">实时</span>}
              {live.streamState === "reconnecting" && <span className="stream-state reconnecting">连接恢复中</span>}
              {queuedCount > 0 && <span className="stream-state">排队 {queuedCount}</span>}
              <span>{snapshot?.session.model.modelId || model}</span>
              {busy && (
                <button type="button" className="icon-command" title="停止" onClick={() => void stop()}>
                  <Icon name="stop" />
                </button>
              )}
            </div>
          </div>

          <div
            className="conversation-scroll"
            ref={scrollRef}
            onScroll={() => {
              const element = scrollRef.current;
              if (!element) return;
              setFollowScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 160);
            }}
          >
            {!snapshot && (
              <div className="agent-intro">
                <span className="eyebrow">ZMZAI AGENT</span>
                <h1>今天想做些什么？</h1>
                <p>读取、改文件、跑命令都在隔离沙箱中自动进行。先选 Workspace，下方描述任务直接开始。</p>
                <div className="fw-quick-tasks" aria-label="快捷任务">
                  {[
                    { label: "生成 PPT", prompt: "帮我生成一份 10 页的季度汇报 PPT，包含封面、目录、核心数据、总结" },
                    { label: "写文档", prompt: "帮我写一份产品需求文档（PRD），包含背景、目标、功能点、验收标准" },
                    { label: "数据分析", prompt: "分析当前 Workspace 里的数据文件，给出关键指标和趋势总结" },
                    { label: "深度研究", prompt: "深度研究一个主题：先列出大纲，再逐节展开，最后给出参考资料" },
                  ].map((task) => (
                    <button key={task.label} type="button" className="fw-quick-task" onClick={() => setPrompt(task.prompt)}>
                      {task.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((entry, index) => (
              <MessageView key={Array.isArray(entry) ? `assistant-${index}-${entry[0]?.info.id}` : entry.info.id} entry={entry} hideTools={live.todos.length > 0} sessionIdle={live.status === "idle"} />
            ))}
            {/* 执行计划放在对话流末尾：它属于 Agent 回复的产物，钉在顶部会
                把用户消息压到下面（用户反馈"我的消息在 Agent 下面"）。 */}
            <TodoChecklist todos={live.todos} tools={taskTools} />
            {live.pendingPermission && <PermissionCard request={live.pendingPermission} busy={replying} onReply={(reply, feedback) => void replyPermission(reply, feedback)} />}
            {live.error && <div className="run-note">{live.error}</div>}
            {!followScroll && (
              <button
                type="button"
                className="jump-to-latest"
                onClick={() => {
                  const element = scrollRef.current;
                  if (element) {
                    element.scrollTop = element.scrollHeight;
                    setFollowScroll(true);
                  }
                }}
              >
                <Icon name="arrow-down" size={12} />
                跳至最新
              </button>
            )}
          </div>

          <form
            className="prompt-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="composer-controls">
              <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="模型" disabled={!models.length}>
                {models.length ? models.map((item) => <option key={item.model} value={item.model}>{item.model}</option>) : <option>模型目录不可用</option>}
              </select>
            </div>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={snapshot ? (busy ? "智能体正在执行，发送将排队…" : "继续这条对话…（Enter 发送，Shift+Enter 换行）") : "描述要完成的任务…"}
              rows={3}
            />
            <div className="composer-actions">
              <span>{busy ? (queuedCount > 0 ? `执行中 · ${queuedCount} 条排队` : "执行中") : "就绪"}</span>
              {busy ? (
                <button type="button" className="command-button quiet" onClick={() => void stop()}>
                  停止
                </button>
              ) : (
                <button type="submit" className="command-button" disabled={!prompt.trim() || sending || (!snapshot && !workspaceId)}>
                  {sending ? "发送中" : busy ? "排队" : "发送"}
                </button>
              )}
            </div>
          </form>
        </section>

        <aside className="fw-canvas">
          <div className="canvas-tabs">
            <button type="button" className={canvasTab === "artifacts" ? "active" : ""} onClick={() => setCanvasTab("artifacts")}>
              产物 <span>{live.artifacts.length}</span>
            </button>
            <button type="button" className={canvasTab === "edits" ? "active" : ""} onClick={() => setCanvasTab("edits")}>
              改动 <span>{live.edits.length}</span>
            </button>
          </div>
          {canvasTab === "artifacts" && (
            <div className="fw-canvas-body">
              {preview?.previewUrl ? (
                <div className="fw-preview-wrap">
                  <div className="fw-preview-head">
                    <span>{preview.path}</span>
                    <button type="button" className="icon-command" title="关闭预览" onClick={() => setPreview(null)}>
                      <Icon name="cross" />
                    </button>
                  </div>
                  <iframe className="fw-preview-frame" src={preview.previewUrl} title={preview.path} sandbox="allow-scripts allow-same-origin" />
                </div>
              ) : null}
              {live.artifacts.length ? (
                live.artifacts.map((artifact) => <ArtifactPreviewCard key={artifact.artifactId} artifact={artifact} onOpen={openArtifact} />)
              ) : (
                <p className="empty-state">沙箱生成的文件会出现在这里，可预览或下载。</p>
              )}
            </div>
          )}
          {canvasTab === "edits" && (
            <div className="fw-canvas-body">
              {live.edits.length ? live.edits.map((edit) => <EditCard key={`${edit.revisionId}-${edit.path}`} edit={edit} />) : <p className="empty-state">Agent 的文件改动（含差异）会出现在这里。</p>}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
