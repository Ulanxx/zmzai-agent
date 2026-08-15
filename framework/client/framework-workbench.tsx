"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Icon } from "@/components/icon";
import { Seal } from "@/components/seal";
import { Button, IconButton, Input, Select as ThemeSelect, SelectTrigger, SelectValue, SelectContent, SelectItem, Tabs, Textarea } from "@zmzai/theme";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  fwApi,
  useFrameworkSession,
  type ArtifactCard,
  type Reply,
  type SessionInfo,
} from "@/framework/client/use-framework-session";
import { ArtifactPreviewCard, EditCard, groupAssistantMessages, MessageView, PermissionCard, PptxPreview, TodoChecklist } from "@/framework/client/parts";

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
  // 首页最近任务（跨 workspace）。
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
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

  // 首页最近任务（跨 workspace，无 session 时加载）。
  useEffect(() => {
    if (sessionId) return;
    void fwApi.listSessions().then((result) => setRecentSessions(result.sessions.slice(0, 6))).catch(() => undefined);
  }, [sessionId]);

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
        <div className="flex items-center gap-2.5">
          <Seal size={24} className="agent-seal" />
          <span className="font-sans text-sm font-semibold tracking-tight">ZMZAI</span>
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">a.zmzai.cloud</span>
        </div>
        <nav className="flex items-center gap-1" aria-label="主导航">
          {sessionId && (
            <Link href="/fw" className="rounded-full px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink" title="返回工作台">
              ← 返回
            </Link>
          )}
          <Link href="/fw" className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${pathname === "/fw" ? "bg-ink text-white" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>新任务</Link>
          <Link href="/audit" className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${pathname === "/audit" ? "bg-ink text-white" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>运行审计</Link>
        </nav>
        <div className="flex items-center gap-2.5">
          {user && (
            <span className="max-w-[8rem] truncate text-sm text-ink-2" title={user.email}>
              {user.name}
            </span>
          )}
          <IconButton size="lg" label="退出登录" onClick={() => void logout()}>
            <Icon name="logout" size={14} />
          </IconButton>
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

      {/* 首页态（Manus 式居中入口）：无任务时隐藏三栏，只显示居中入口 + 最近任务。 */}
      {!snapshot && !loading && (
        <div className="fw-home">
          <div className="fw-home-hero">
            <h1 className="text-3xl font-semibold tracking-tight">今天想做些什么？</h1>
            <div className="flex flex-wrap justify-center gap-2" aria-label="快捷任务">
              {[
                { label: "生成 PPT", prompt: "帮我生成一份 10 页的季度汇报 PPT，包含封面、目录、核心数据、总结" },
                { label: "写文档", prompt: "帮我写一份产品需求文档（PRD），包含背景、目标、功能点、验收标准" },
                { label: "数据分析", prompt: "分析当前 Workspace 里的数据文件，给出关键指标和趋势总结" },
                { label: "深度研究", prompt: "深度研究一个主题：先列出大纲，再逐节展开，最后给出参考资料" },
              ].map((task) => (
                <Button key={task.label} type="button" variant="secondary" size="sm" onClick={() => setPrompt(task.prompt)}>
                  {task.label}
                </Button>
              ))}
            </div>
          </div>
          <form
            className="w-full max-w-3xl rounded-xl border border-line bg-bg p-6 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="mb-3 flex gap-2">
              <ThemeSelect value={workspaceId ?? undefined} onValueChange={(v: string) => setWorkspaceId(v || null)}>
                <SelectTrigger className="w-auto" aria-label="智能体">
                  <SelectValue placeholder="选择智能体" />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.length ? workspaces.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                  )) : <SelectItem value="">请先创建智能体</SelectItem>}
                </SelectContent>
              </ThemeSelect>
              <ThemeSelect value={model || undefined} onValueChange={setModel}>
                <SelectTrigger className="w-auto" aria-label="模型">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {models.length ? models.map((item) => <SelectItem key={item.model} value={item.model}>{item.model}</SelectItem>) : <SelectItem value="">模型目录不可用</SelectItem>}
                </SelectContent>
              </ThemeSelect>
            </div>
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="描述要完成的任务…（Enter 发送）"
              rows={5}
              className="w-full resize-none text-base"
            />
            <div className="mt-3 flex items-center justify-between">
              <span className="text-sm text-ink-3">{workspaces.find((w) => w.id === workspaceId)?.name ?? "选择智能体"}</span>
              <Button type="submit" disabled={!prompt.trim() || sending || !workspaceId}>
                {sending ? "发送中…" : "开始任务 →"}
              </Button>
            </div>
          </form>
          {recentSessions.length > 0 && (
            <div className="w-full max-w-2xl">
              <span className="mb-3 block text-xs font-semibold uppercase tracking-wide text-ink-3">最近任务</span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
                {recentSessions.map((item) => (
                  <Button type="button" key={item.id} variant="ghost"
                    className="w-full justify-start rounded-xl border border-line bg-bg p-3 hover:border-ink hover:shadow-md"
                    onClick={() => router.push(`/fw/s/${item.id}`)}>
                    <span className="flex w-full flex-col items-start gap-0.5">
                      <strong className="block truncate text-sm font-semibold">{item.title}</strong>
                      <small className="font-mono text-xs text-ink-3">{item.agent}</small>
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 任务态：三栏工作台——侧栏可收起，对话区/画布用 PanelGroup 拖动分栏。 */}
      {snapshot && (
      <div className={sidebarCollapsed ? "fw-grid sidebar-hidden" : "fw-grid"}>
        <aside className={sidebarCollapsed ? "fw-sidebar collapsed" : "fw-sidebar"}>
          <div className="flex items-center justify-between px-1 pb-2">
            <IconButton size="md" label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCollapsed((value) => !value)}>
              <Icon name={sidebarCollapsed ? "chevron-down" : "cross"} size={14} />
            </IconButton>
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">智能体</span>
            <IconButton size="md" label="新建 Workspace" onClick={() => setCreatingWs((value) => !value)}>
              <Icon name="plus" size={14} />
            </IconButton>
          </div>
          {creatingWs && (
            <form
              className="mt-1 flex gap-1.5 px-1"
              onSubmit={(event) => {
                event.preventDefault();
                void createWorkspace(event);
              }}
            >
              <Input name="name" autoFocus maxLength={120} placeholder="智能体名称" className="min-w-0 flex-1" />
              <Button type="submit" size="sm">创建</Button>
            </form>
          )}
          <nav className="mt-1 flex flex-col gap-0.5" aria-label="Workspace 列表">
            {workspaces.map((item) => (
              <div key={item.id} className={`group rounded-lg border border-transparent transition-colors ${item.id === workspaceId ? "border-line bg-surface" : "hover:bg-surface"}`}>
                {renamingWs === item.id ? (
                  <form
                    className="flex items-center gap-1.5 px-1.5 py-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void renameWorkspace(item.id);
                    }}
                  >
                    <Input value={renamingName} onChange={(event) => setRenamingName(event.target.value)} autoFocus maxLength={120} aria-label="智能体名称" className="min-w-0 flex-1" />
                    <Button type="submit" size="icon" variant="ghost" className="h-6 w-6" title="保存">
                      <Icon name="check" size={12} />
                    </Button>
                  </form>
                ) : (
                  <Button type="button" variant="ghost" className="w-full justify-start px-2.5 py-2" onClick={() => setWorkspaceId(item.id)}>
                    <span className="block truncate">{item.name}</span>
                  </Button>
                )}
                <div className="flex gap-0.5 px-1.5 pb-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <IconButton size="sm" label="配置智能体" onClick={() => router.push(`/fw/w/${item.id}`)}><Icon name="settings" size={12} /></IconButton>
                  <IconButton size="sm" label="重命名" onClick={() => { setRenamingWs(item.id); setRenamingName(item.name); setConfirmDeleteWs(null); }}><Icon name="edit" size={12} /></IconButton>
                  <IconButton size="sm" tone="quiet" label={confirmDeleteWs === item.id ? "确认删除" : "删除"} onClick={() => setConfirmDeleteWs(confirmDeleteWs === item.id ? null : item.id)}><Icon name="trash" size={12} /></IconButton>
                </div>
                {confirmDeleteWs === item.id && (
                  <div className="mx-1.5 mb-1 rounded-lg border border-line bg-surface p-2 text-xs text-ink-2">
                    <span>删除后会话、产物、文件版本全部清除，不可恢复。</span>
                    <div className="mt-1.5 flex justify-end gap-1.5">
                      <Button type="button" variant="danger" size="sm" onClick={() => void removeWorkspace(item.id)}>确认删除</Button>
                      <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmDeleteWs(null)}>取消</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </nav>
          <section className="mt-4">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">任务</span>
              <small className="rounded-full bg-surface-2 px-1.5 text-xs text-ink-3">{sessions.length}</small>
            </div>
            {sessions.length > 5 && (
              <Input
                className="mb-2 w-full"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="搜索会话"
                aria-label="搜索会话"
              />
            )}
            <nav className="flex flex-col gap-0.5" aria-label="会话列表">
              {sessions
                .filter((item) => !sessionQuery.trim() || item.title.toLowerCase().includes(sessionQuery.trim().toLowerCase()) || item.agent.toLowerCase().includes(sessionQuery.trim().toLowerCase()))
                .map((item) => (
                <button type="button" key={item.id}
                  className={`w-full justify-start rounded-sm border border-transparent px-2.5 py-1.5 ${item.id === sessionId ? "border-line bg-surface" : "hover:bg-surface-2"}`}
                  onClick={() => router.push(`/fw/s/${item.id}`)}>
                  <strong className="block truncate text-sm font-medium">{item.title}</strong>
                  <small className="font-mono text-xs text-ink-3">{item.agent}</small>
                </button>
              ))}
              {!sessions.length && <p className="px-2.5 py-2 text-sm text-ink-3">此智能体还没有任务。</p>}
              {sessions.length > 0 && sessions.filter((item) => !sessionQuery.trim() || item.title.toLowerCase().includes(sessionQuery.trim().toLowerCase())).length === 0 && <p className="px-2.5 py-2 text-sm text-ink-3">没有匹配的会话。</p>}
            </nav>
          </section>
        </aside>

        <div className="fw-main">
        <PanelGroup direction="horizontal" autoSaveId="fw-conv-canvas-split">
          <Panel defaultSize={50} minSize={20} className="fw-panel">

        <section className="fw-conversation">
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              {sidebarCollapsed && (
                <IconButton size="md" label="展开侧栏" onClick={() => setSidebarCollapsed(false)}>
                  <Icon name="chevron-down" size={14} className="-rotate-90" />
                </IconButton>
              )}
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-tight">{snapshot?.session.title ?? "新任务"}</h1>
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${live.status === "idle" ? "bg-success/10 text-success" : "bg-accent/10 text-accent"}`}>
                {live.status === "idle" ? "空闲" : live.status === "waiting_permission" ? "等待审批" : "进行中"}
              </span>
              {live.streamState === "live" && busy && <span className="rounded-full border border-success px-2 py-0.5 text-xs text-success">实时</span>}
              {live.streamState === "reconnecting" && <span className="rounded-full border border-accent px-2 py-0.5 text-xs text-accent">连接恢复中</span>}
              {queuedCount > 0 && <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-3">排队 {queuedCount}</span>}
              <span className="font-mono text-xs text-ink-3">{snapshot?.session.model.modelId || model}</span>
              {busy && (
                <IconButton size="md" label="停止" onClick={() => void stop()}>
                  <Icon name="stop" size={14} />
                </IconButton>
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
            {messages.map((entry, index) => (
              <MessageView key={Array.isArray(entry) ? `assistant-${index}-${entry[0]?.info.id}` : entry.info.id} entry={entry} hideTools={live.todos.length > 0} sessionIdle={live.status === "idle"} />
            ))}
            <TodoChecklist todos={live.todos} tools={taskTools} />
            {live.pendingPermission && <PermissionCard request={live.pendingPermission} busy={replying} onReply={(reply, feedback) => void replyPermission(reply, feedback)} />}
            {live.error && <div className="mx-auto my-2 max-w-2xl rounded-lg border border-accent bg-accent/5 px-3 py-2 text-sm text-accent">{live.error}</div>}
            {!followScroll && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="sticky bottom-4 float-right mr-2 shadow-md"
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
              </Button>
            )}
          </div>

          <form
            className="border-t border-line bg-bg px-5 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="mb-2 flex gap-2">
              <ThemeSelect value={model || undefined} onValueChange={setModel}>
                <SelectTrigger className="h-8 w-auto text-xs" aria-label="模型">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {models.length ? models.map((item) => <SelectItem key={item.model} value={item.model}>{item.model}</SelectItem>) : <SelectItem value="">模型目录不可用</SelectItem>}
                </SelectContent>
              </ThemeSelect>
            </div>
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={snapshot ? (busy ? "智能体正在执行，发送将排队…" : "继续这条对话…（Enter 发送，Shift+Enter 换行）") : "描述要完成的任务…"}
              rows={3}
              className="w-full resize-none"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-ink-3">{busy ? (queuedCount > 0 ? `执行中 · ${queuedCount} 条排队` : "执行中") : "就绪"}</span>
              {busy ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => void stop()}>
                  停止
                </Button>
              ) : (
                <Button type="submit" size="sm" disabled={!prompt.trim() || sending || (!snapshot && !workspaceId)}>
                  {sending ? "发送中…" : busy ? "排队" : "发送 →"}
                </Button>
              )}
            </div>
          </form>
        </section>

          </Panel>
          <PanelResizeHandle className="fw-resizer" />
          <Panel defaultSize={50} minSize={20} collapsible collapsedSize={0} className="fw-panel">
        <aside className="fw-canvas">
          <Tabs
            className="px-4"
            items={[
              { value: "artifacts", label: "产物", count: live.artifacts.length },
              { value: "edits", label: "改动", count: live.edits.length },
            ]}
            value={canvasTab}
            onValueChange={(value) => setCanvasTab(value as CanvasTab)}
          />
          {canvasTab === "artifacts" && (
            <div className="fw-canvas-body flex flex-col gap-2 p-3">
              {preview ? (
                <div className="overflow-hidden rounded-xl border border-line">
                  <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                    <span className="font-mono text-xs">{preview.path}</span>
                    <IconButton size="sm" label="关闭预览" onClick={() => setPreview(null)}><Icon name="cross" size={12} /></IconButton>
                  </div>
                  {preview.contentType.includes("presentationml.presentation") ? (
                    <div className="max-h-[32rem] overflow-auto bg-white">
                      <PptxPreview previewUrl={preview.previewUrl ?? preview.downloadUrl.replace(/\/download$/, "/preview")} />
                    </div>
                  ) : preview.previewUrl ? (
                    <iframe className="h-80 w-full border-0 bg-white" src={preview.previewUrl} title={preview.path} sandbox="allow-scripts allow-same-origin" />
                  ) : (
                    <div className="flex flex-col items-center gap-2 bg-white p-6 text-center">
                      <span className="text-xs text-ink-3">该类型暂不支持在线预览，可下载查看</span>
                      <a className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2" href={preview.downloadUrl}>下载文件</a>
                    </div>
                  )}
                </div>
              ) : null}
              {live.artifacts.length ? (
                live.artifacts.map((artifact) => <ArtifactPreviewCard key={artifact.artifactId} artifact={artifact} onOpen={openArtifact} />)
              ) : (
                <p className="px-2 py-4 text-center text-sm text-ink-3">沙箱生成的文件会出现在这里，可预览或下载。</p>
              )}
            </div>
          )}
          {canvasTab === "edits" && (
            <div className="fw-canvas-body flex flex-col gap-2 p-3">
              {live.edits.length ? live.edits.map((edit) => <EditCard key={`${edit.revisionId}-${edit.path}`} edit={edit} />) : <p className="px-2 py-4 text-center text-sm text-ink-3">Agent 的文件改动（含差异）会出现在这里。</p>}
            </div>
          )}
        </aside>
          </Panel>
        </PanelGroup>
        </div>
      </div>
      )}
    </main>
  );
}