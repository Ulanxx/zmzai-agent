"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Workspace = { id: string; name: string; description: string; defaultModel: string; currentRevisionId: string | null; updatedAt: string };
type WorkspaceFile = { path: string; content: string; revisionId: string | null; updatedAt: string };
type Revision = { id: string; summary: string; createdAt: string; changes: Array<{ path: string }> };
type Model = { model: string; maxOutputTokens: number };
type Run = { id: string; workspaceId: string; mode: "plan" | "build"; model: string; prompt: string; status: string; failureCode: string | null };
type TaskEvent = { id: string; sequence: number; type: string; at: string; data: Record<string, unknown> };

function requestId(): string {
  return crypto.randomUUID();
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "请求失败，请稍后重试");
  return body as T;
}

function activity(event: TaskEvent): string | null {
  const name = typeof event.data.name === "string" ? event.data.name : "";
  const args = event.data.args && typeof event.data.args === "object" ? event.data.args as { path?: unknown; query?: unknown } : {};
  if (event.type === "tool.requested") {
    if (name === "read") return `正在读取 ${typeof args.path === "string" ? args.path : "文件"}`;
    if (name === "search") return `正在搜索 ${typeof args.query === "string" ? `“${args.query}”` : "文件"}`;
    if (name === "list") return "正在列出 Workspace 文件";
  }
  if (event.type === "tool.completed") return name === "search" ? "已完成文件搜索" : name === "read" ? "已读取文件" : name === "list" ? "已列出文件" : null;
  return null;
}

function runPhase(status: string | undefined): string {
  if (status === "running" || status === "queued") return "进行中";
  if (status === "succeeded") return "已完成";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return "失败";
  return "待开始";
}

export function AgentWorkbench() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSource = useRef<EventSource | null>(null);

  const workspace = useMemo(() => workspaces.find((item) => item.id === selectedId) ?? null, [workspaces, selectedId]);
  const message = useMemo(() => events.filter((event) => event.type === "message.delta").map((event) => typeof event.data.delta === "string" ? event.data.delta : "").join(""), [events]);
  const activities = useMemo(() => events.map(activity).filter((item): item is string => Boolean(item)), [events]);
  const currentFile = files.find((file) => file.path === selectedFile) ?? null;

  const closeEvents = useCallback(() => {
    eventSource.current?.close();
    eventSource.current = null;
  }, []);

  const loadWorkspaceContext = useCallback(async (workspaceId: string) => {
    const [fileResult, revisionResult] = await Promise.all([
      requestJson<{ files: WorkspaceFile[] }>(`/api/workspaces/${workspaceId}/files`),
      requestJson<{ revisions: Revision[] }>(`/api/workspaces/${workspaceId}/revisions`),
    ]);
    setFiles(fileResult.files);
    setRevisions(revisionResult.revisions);
    setSelectedFile((current) => current && fileResult.files.some((file) => file.path === current) ? current : fileResult.files[0]?.path ?? null);
  }, []);

  const selectWorkspace = useCallback(async (workspaceId: string) => {
    closeEvents();
    setSelectedId(workspaceId);
    const nextWorkspace = workspaces.find((item) => item.id === workspaceId);
    if (nextWorkspace) setModel(nextWorkspace.defaultModel);
    setRun(null);
    setEvents([]);
    setError(null);
    try { await loadWorkspaceContext(workspaceId); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取 Workspace"); }
  }, [closeEvents, loadWorkspaceContext, workspaces]);

  useEffect(() => {
    void (async () => {
      try {
        const [workspaceResult, modelResult] = await Promise.allSettled([
          requestJson<{ workspaces: Workspace[] }>("/api/workspaces"),
          requestJson<{ models: Model[] }>("/api/models"),
        ]);
        if (workspaceResult.status === "rejected") throw workspaceResult.reason;
        setWorkspaces(workspaceResult.value.workspaces);
        if (modelResult.status === "fulfilled") setModels(modelResult.value.models);
        else setError(modelResult.reason instanceof Error ? modelResult.reason.message : "模型目录暂时不可用");
        const first = workspaceResult.value.workspaces[0];
        if (first) {
          setSelectedId(first.id);
          setModel(modelResult.status === "fulfilled" && modelResult.value.models.some((item) => item.model === first.defaultModel) ? first.defaultModel : modelResult.status === "fulfilled" ? modelResult.value.models[0]?.model ?? "" : first.defaultModel);
          await loadWorkspaceContext(first.id);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法加载工作台");
      } finally { setLoading(false); }
    })();
    return closeEvents;
  }, [closeEvents, loadWorkspaceContext]);

  const subscribe = useCallback((runId: string) => {
    closeEvents();
    const source = new EventSource(`/api/runs/${runId}/events`);
    eventSource.current = source;
    source.onmessage = (messageEvent) => {
      try {
        const event = JSON.parse(messageEvent.data) as TaskEvent;
        setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event]);
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
          setRun((current) => current ? { ...current, status: event.type === "run.completed" ? "succeeded" : event.type === "run.cancelled" ? "cancelled" : "failed" } : current);
          source.close();
        }
      } catch { setError("任务事件格式无效"); }
    };
    source.onerror = () => { source.close(); };
  }, [closeEvents]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name || !model) return;
    setCreating(true);
    setError(null);
    try {
      const result = await requestJson<{ workspace: Workspace }>("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestId() },
        body: JSON.stringify({ name, description: "", defaultModel: model }),
      });
      setWorkspaces((current) => [result.workspace, ...current]);
      setCreating(false);
      await selectWorkspace(result.workspace.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建 Workspace 失败"); setCreating(false); }
  }

  async function startPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !prompt.trim() || !model || run?.status === "running" || run?.status === "queued") return;
    setError(null);
    setEvents([]);
    try {
      const result = await requestJson<{ run: Run }>(`/api/workspaces/${workspace.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestId() },
        body: JSON.stringify({ mode: "plan", model, prompt: prompt.trim() }),
      });
      setRun(result.run);
      subscribe(result.run.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法启动任务"); }
  }

  async function cancelRun() {
    if (!run) return;
    try {
      const result = await requestJson<{ run: Run }>(`/api/runs/${run.id}/cancel`, { method: "POST", headers: { "idempotency-key": requestId() } });
      setRun(result.run);
      closeEvents();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "取消失败"); }
  }

  if (loading) return <main className="workbench-loading">正在建立工作台...</main>;

  return (
    <main className="workbench">
      <header className="workbench-header">
        <div className="flex items-center gap-3"><span className="agent-mark">使</span><span className="font-mono text-sm font-bold tracking-[0.08em]">ZMZAI AGENT</span></div>
        <div className="workbench-status"><span className="status-dot" />PLAN WORKBENCH <span className="header-domain">a.zmzai.cloud</span></div>
      </header>
      {error && <div className="workbench-alert">{error}{run?.failureCode === "INSUFFICIENT_CREDITS" && <a href="https://m.zmzai.cloud" target="_blank" rel="noreferrer">前往提额</a>}</div>}

      <div className="workbench-grid">
        <aside className="workspace-pane">
          <div className="pane-heading"><span>WORKSPACE</span><button type="button" className="icon-command" title="新建 Workspace" onClick={() => setCreating((value) => !value)}>+</button></div>
          {creating && <form className="workspace-create" onSubmit={createWorkspace}><input name="name" autoFocus maxLength={120} placeholder="Workspace 名称" /><button type="submit">创建</button></form>}
          <nav className="workspace-list" aria-label="Workspace 列表">
            {workspaces.map((item) => <button type="button" key={item.id} className={item.id === selectedId ? "workspace-item active" : "workspace-item"} onClick={() => void selectWorkspace(item.id)}><span>{item.name}</span><small>{item.currentRevisionId ? "已版本化" : "草稿"}</small></button>)}
          </nav>
          {!workspaces.length && <p className="empty-state">先创建一个 Workspace，再让 Agent 阅读其中的文件。</p>}
          <section className="file-tree"><div className="pane-heading"><span>FILES</span><small>{files.length}</small></div>{files.map((file) => <button type="button" key={file.path} onClick={() => setSelectedFile(file.path)} className={file.path === selectedFile ? "file-item active" : "file-item"}>{file.path}</button>)}</section>
          <section className="revision-list"><div className="pane-heading"><span>REVISIONS</span><small>{revisions.length}</small></div>{revisions.slice(0, 4).map((revision) => <div className="revision-item" key={revision.id}>{revision.summary || "Workspace revision"}</div>)}</section>
        </aside>

        <section className="conversation-pane">
          <div className="pane-heading"><span>任务对话</span>{run && <span className="run-phase">{runPhase(run.status)}</span>}</div>
          <div className="conversation-scroll">
            {!run && <div className="agent-intro"><span className="eyebrow">PLAN MODE</span><h1>从 Workspace 开始</h1><p>我可以列出、读取和搜索当前 Workspace 的文本文件，并给出可核实的中文方案。</p></div>}
            {run && <article className="user-message"><span>你的任务</span><p>{run.prompt}</p></article>}
            {activities.map((item, index) => <div className="tool-activity" key={`${item}-${index}`}>{item}</div>)}
            {message && <article className="agent-message"><span>Agent</span><p>{message}</p></article>}
            {run?.status === "failed" && <div className="run-note">任务未完成。{run.failureCode === "INSUFFICIENT_CREDITS" ? "余额不足，请前往 m.zmzai.cloud 提额。" : "请检查模型、Relay 或 Workspace 后重试。"}</div>}
          </div>
          <form className="prompt-composer" onSubmit={startPlan}>
            <div className="composer-controls"><span className="mode-pill">PLAN</span><select value={model} onChange={(event) => setModel(event.target.value)} disabled={!models.length || !workspace}>{models.length ? models.map((item) => <option key={item.model} value={item.model}>{item.model}</option>) : <option>模型目录不可用</option>}</select><span className="mode-planned">BUILD 稍后开放</span></div>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={workspace ? "描述要分析、梳理或规划的任务..." : "先选择或创建 Workspace"} disabled={!workspace} rows={3} />
            <div className="composer-actions"><span>只读权限 · list / read / search</span>{run && ["queued", "running"].includes(run.status) ? <button type="button" className="command-button quiet" onClick={() => void cancelRun()}>停止</button> : <button type="submit" className="command-button" disabled={!workspace || !prompt.trim() || !model}>开始 Plan</button>}</div>
          </form>
        </section>

        <aside className="canvas-pane">
          <div className="pane-heading"><span>上下文画布</span><span className="canvas-live">LIVE</span></div>
          <div className="canvas-tabs"><button type="button" className={!currentFile ? "active" : ""} onClick={() => setSelectedFile(null)}>任务</button><button type="button" className={currentFile ? "active" : ""} onClick={() => setSelectedFile(files[0]?.path ?? null)}>文件</button></div>
          {currentFile ? <section className="file-preview"><div className="file-preview-title">{currentFile.path}</div><pre>{currentFile.content || "此文件为空。"}</pre></section> : <section className="task-canvas"><span className="canvas-index">01</span><h2>{workspace?.name ?? "未选择 Workspace"}</h2><dl><div><dt>模式</dt><dd>只读 Plan</dd></div><div><dt>模型</dt><dd>{model || "未选择"}</dd></div><div><dt>文件</dt><dd>{files.length} 项</dd></div><div><dt>版本</dt><dd>{workspace?.currentRevisionId ? "当前版本" : "尚未创建"}</dd></div></dl><p>画布仅投影 Workspace、任务与事件的持久化状态。</p></section>}
        </aside>
      </div>
    </main>
  );
}
