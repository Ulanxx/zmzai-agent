"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { projectTaskEvents, type CanvasArtifact, type TaskEvent, type ToolNode } from "@/lib/task-event-projection";

type Workspace = { id: string; name: string; description: string; defaultModel: string; currentRevisionId: string | null; updatedAt: string };
type WorkspaceFile = { path: string; content: string; revisionId: string | null; updatedAt: string };
type Revision = { id: string; summary: string; createdAt: string; changes: Array<{ path: string }> };
type Model = { model: string; maxOutputTokens: number };
type Run = { id: string; workspaceId: string; mode: "plan" | "build"; model: string; prompt: string; status: string; failureCode: string | null; createdAt: string; updatedAt: string };
type ProposalChange = { path: string; operation: "create" | "update" | "delete"; before: string | null; after: string | null };
type Proposal = { id: string; runId: string; baseRevisionId: string | null; status: "pending" | "approved" | "rejected" | "superseded"; approvedRevisionId: string | null; summary: string; diff: string; changes: ProposalChange[]; createdAt: string; updatedAt: string };
type CanvasTab = "task" | "file" | "proposal" | "artifact";
type StreamState = "idle" | "live" | "reconnecting" | "closed";

function requestId(): string {
  return crypto.randomUUID();
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "请求失败，请稍后重试");
  return body as T;
}

function runPhase(status: string | undefined): string {
  if (status === "running" || status === "queued") return "进行中";
  if (status === "waiting_approval") return "等待审批";
  if (status === "succeeded") return "已完成";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return "失败";
  return "待开始";
}

function durationLabel(value: number | null): string {
  if (value === null) return "";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s`;
}

function runTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ToolCard({ tool, onOpenArtifact }: { tool: ToolNode; onOpenArtifact: (toolCallId: string) => void }) {
  return <article className={`tool-card ${tool.status}`}>
    <div className="tool-card-head"><div><span className="tool-card-name">{tool.name}</span><span className="tool-card-args">{tool.argsSummary}</span></div><span className="tool-card-state">{tool.status === "requested" ? "准备中" : tool.status === "running" ? "执行中" : tool.status === "failed" ? "失败" : "完成"}</span></div>
    <div className="tool-card-body"><span>{tool.resultSummary?.text ?? tool.label}</span><span className="tool-card-meta">{durationLabel(tool.durationMs)}</span>{tool.status !== "requested" && <button type="button" className="tool-card-open" onClick={() => onOpenArtifact(tool.id)}>查看上下文</button>}</div>
    {tool.resultSummary?.truncated && <p className="tool-card-truncated">结果已截断，省略 {tool.resultSummary.omittedBytes} B</p>}
  </article>;
}

function ArtifactView({ artifact }: { artifact: CanvasArtifact }) {
  const payload = artifact.payload;
  if (artifact.kind === "file_preview") return <section className="artifact-canvas"><div className="artifact-head"><span className="canvas-index">文件</span><h2>{artifact.title}</h2></div><pre>{typeof payload.content === "string" ? payload.content : "文件内容不可用"}</pre>{payload.truncated === true && <p className="artifact-note">预览已截断，完整内容仍保留在 Workspace。</p>}</section>;
  if (artifact.kind === "search_results") return <section className="artifact-canvas"><div className="artifact-head"><span className="canvas-index">检索</span><h2>{artifact.title}</h2></div><ol className="search-results">{Array.isArray(payload.matches) ? payload.matches.map((match, index) => { const item = match && typeof match === "object" ? match as Record<string, unknown> : {}; return <li key={`${String(item.path)}-${index}`}><span>{String(item.path ?? "文件")}:{String(item.line ?? "")}</span><p>{String(item.text ?? "")}</p></li>; }) : <li>没有可显示的命中。</li>}</ol>{payload.truncated === true && <p className="artifact-note">仅显示前 20 条命中。</p>}</section>;
  return <section className="artifact-canvas"><div className="artifact-head"><span className="canvas-index">输出</span><h2>{artifact.title}</h2></div><pre>{typeof payload.content === "string" ? payload.content : "等待输出"}</pre></section>;
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
  const [runHistory, setRunHistory] = useState<Run[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [mode, setMode] = useState<"plan" | "build">("plan");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [canvasTab, setCanvasTab] = useState<CanvasTab>("task");
  const [canvasFollow, setCanvasFollow] = useState(true);
  const [pinnedArtifactId, setPinnedArtifactId] = useState<string | null>(null);
  const [resolvingProposal, setResolvingProposal] = useState<"approve" | "reject" | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const eventSource = useRef<EventSource | null>(null);

  const workspace = useMemo(() => workspaces.find((item) => item.id === selectedId) ?? null, [workspaces, selectedId]);
  const projection = useMemo(() => projectTaskEvents(events), [events]);
  const activeArtifact = useMemo(() => canvasFollow ? projection.artifacts.at(-1) ?? null : projection.artifacts.find((artifact) => artifact.id === pinnedArtifactId) ?? null, [canvasFollow, pinnedArtifactId, projection.artifacts]);
  const currentFile = files.find((file) => file.path === selectedFile) ?? null;
  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? proposals[0] ?? null;

  const closeEvents = useCallback(() => {
    eventSource.current?.close();
    eventSource.current = null;
    setStreamState("closed");
  }, []);

  const loadWorkspaceContext = useCallback(async (workspaceId: string) => {
    const [fileResult, revisionResult, runResult] = await Promise.all([
      requestJson<{ files: WorkspaceFile[] }>(`/api/workspaces/${workspaceId}/files`),
      requestJson<{ revisions: Revision[] }>(`/api/workspaces/${workspaceId}/revisions`),
      requestJson<{ runs: Run[] }>(`/api/workspaces/${workspaceId}/runs?limit=30`),
    ]);
    setFiles(fileResult.files);
    setRevisions(revisionResult.revisions);
    setRunHistory(runResult.runs);
    setSelectedFile((current) => current && fileResult.files.some((file) => file.path === current) ? current : fileResult.files[0]?.path ?? null);
  }, []);

  const loadProposals = useCallback(async (runId: string) => {
    const result = await requestJson<{ proposals: Proposal[] }>(`/api/runs/${runId}/proposals`);
    setProposals(result.proposals);
    setSelectedProposalId((current) => current && result.proposals.some((proposal) => proposal.id === current) ? current : result.proposals[0]?.id ?? null);
    return result.proposals;
  }, []);

  const selectWorkspace = useCallback(async (workspaceId: string) => {
    closeEvents();
    setSelectedId(workspaceId);
    const nextWorkspace = workspaces.find((item) => item.id === workspaceId);
    if (nextWorkspace) setModel(nextWorkspace.defaultModel);
    setRun(null);
    setRunHistory([]);
    setEvents([]);
    setProposals([]);
    setSelectedProposalId(null);
    setCanvasTab("task");
    setCanvasFollow(true);
    setPinnedArtifactId(null);
    setStreamState("idle");
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
        } else if (modelResult.status === "fulfilled") {
          setModel(modelResult.value.models[0]?.model ?? "");
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法加载工作台");
      } finally { setLoading(false); }
    })();
    return closeEvents;
  }, [closeEvents, loadWorkspaceContext]);

  const subscribe = useCallback((runId: string, workspaceId: string, historicalTerminal = false) => {
    closeEvents();
    const source = new EventSource(`/api/runs/${runId}/events`);
    eventSource.current = source;
    setStreamState("reconnecting");
    source.onopen = () => {
      if (eventSource.current === source) setStreamState("live");
    };
    const handleEvent = (messageEvent: MessageEvent<string>) => {
      try {
        const event = JSON.parse(messageEvent.data) as TaskEvent;
        setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event]);
        if (["proposal.created", "proposal.updated", "approval.required"].includes(event.type)) {
          void loadProposals(runId).then((nextProposals) => {
            if (nextProposals.length && canvasFollow) setCanvasTab("proposal");
          }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法读取提案"));
        }
        if (event.type === "artifact.upsert" && canvasFollow) setCanvasTab("artifact");
        if (event.type === "run.waiting_approval") setRun((current) => current ? { ...current, status: "waiting_approval" } : current);
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
          const status = event.type === "run.completed" ? "succeeded" : event.type === "run.cancelled" ? "cancelled" : "failed";
          setRun((current) => current ? { ...current, status } : current);
          setRunHistory((current) => current.map((item) => item.id === runId ? { ...item, status } : item));
          void loadWorkspaceContext(workspaceId).catch(() => undefined);
          source.close();
          if (eventSource.current === source) eventSource.current = null;
          setStreamState("closed");
        }
      } catch { setError("任务事件格式无效"); }
    };
    for (const type of ["run.queued", "run.started", "run.waiting_approval", "run.completed", "run.failed", "run.cancelled", "message.started", "message.delta", "message.completed", "tool.requested", "tool.progress", "tool.completed", "tool.failed", "artifact.upsert", "artifact.append", "proposal.created", "proposal.updated", "approval.required", "approval.resolved", "revision.created"]) source.addEventListener(type, handleEvent);
    source.onmessage = handleEvent;
    source.onerror = () => {
      // EventSource 会自动携带 Last-Event-ID 重连；断线期间保留已投影事件。
      if (eventSource.current !== source) return;
      if (historicalTerminal) {
        source.close();
        eventSource.current = null;
        setStreamState("closed");
        return;
      }
      setStreamState("reconnecting");
    };
  }, [canvasFollow, closeEvents, loadProposals, loadWorkspaceContext]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name) {
      setError("请输入 Workspace 名称");
      return;
    }
    if (!model) {
      setError("没有可用模型，请先到 m.zmzai.cloud 配置 Relay 模型");
      return;
    }
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

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !prompt.trim() || !model || run && ["running", "queued", "waiting_approval"].includes(run.status)) return;
    setError(null);
    setEvents([]);
    setProposals([]);
    setSelectedProposalId(null);
    setCanvasTab("task");
    setCanvasFollow(true);
    setPinnedArtifactId(null);
    try {
      const result = await requestJson<{ run: Run }>(`/api/workspaces/${workspace.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestId() },
        body: JSON.stringify({ mode, model, prompt: prompt.trim() }),
      });
      setRun(result.run);
      setRunHistory((current) => [result.run, ...current.filter((item) => item.id !== result.run.id)]);
      subscribe(result.run.id, workspace.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法启动任务"); }
  }

  async function cancelRun() {
    if (!run) return;
    try {
      const result = await requestJson<{ run: Run }>(`/api/runs/${run.id}/cancel`, { method: "POST", headers: { "idempotency-key": requestId() } });
      setRun(result.run);
      setRunHistory((current) => current.map((item) => item.id === result.run.id ? result.run : item));
      closeEvents();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "取消失败"); }
  }

  async function resolveSelectedProposal(action: "approve" | "reject") {
    if (!workspace || !selectedProposal || resolvingProposal || run?.status !== "waiting_approval") return;
    setResolvingProposal(action);
    setError(null);
    try {
      const result = await requestJson<{ proposal: Proposal; revisionId?: string | null }>(`/api/proposals/${selectedProposal.id}/${action}`, {
        method: "POST",
        headers: { "idempotency-key": requestId() },
      });
      setProposals((current) => current.map((proposal) => proposal.id === result.proposal.id ? result.proposal : proposal));
      if (action === "approve" && result.revisionId) {
        setWorkspaces((current) => current.map((item) => item.id === workspace.id ? { ...item, currentRevisionId: result.revisionId ?? item.currentRevisionId } : item));
        await loadWorkspaceContext(workspace.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "审批操作失败");
      void loadProposals(selectedProposal.runId).catch(() => undefined);
    } finally { setResolvingProposal(null); }
  }

  function openToolArtifact(toolCallId: string) {
    const artifact = projection.artifacts.find((item) => item.toolCallId === toolCallId);
    if (!artifact) return;
    setCanvasFollow(false);
    setPinnedArtifactId(artifact.id);
    setCanvasTab("artifact");
  }

  function openRunHistory(item: Run) {
    closeEvents();
    setRun(item);
    setEvents([]);
    setProposals([]);
    setSelectedProposalId(null);
    setCanvasTab("task");
    setCanvasFollow(true);
    setPinnedArtifactId(null);
    setError(null);
    void loadProposals(item.id).catch(() => undefined);
    subscribe(item.id, item.workspaceId, ["succeeded", "failed", "cancelled"].includes(item.status));
  }

  if (loading) return <main className="workbench-loading">正在建立工作台...</main>;

  return (
    <main className="workbench">
      <header className="workbench-header">
        <div className="flex items-center gap-3"><span className="agent-mark">使</span><span className="font-mono text-sm font-bold tracking-[0.08em]">ZMZAI AGENT</span></div>
        <nav className="workbench-nav" aria-label="主导航"><Link href="/audit">运行审计</Link></nav>
        <div className="workbench-status"><span className="status-dot" />AGENT WORKBENCH <span className="header-domain">a.zmzai.cloud</span></div>
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
          <section className="run-history"><div className="pane-heading"><span>RUN HISTORY</span><small>{runHistory.length}</small></div>{runHistory.length ? <nav className="run-history-list" aria-label="任务历史">{runHistory.map((item) => <button type="button" key={item.id} className={item.id === run?.id ? "run-history-item active" : "run-history-item"} onClick={() => openRunHistory(item)}><span className={`run-history-status ${item.status}`}>{runPhase(item.status)}</span><strong>{item.prompt}</strong><small>{runTimeLabel(item.createdAt)} · {item.mode.toUpperCase()}</small></button>)}</nav> : <p className="empty-state">此 Workspace 还没有任务记录。</p>}</section>
          <section className="file-tree"><div className="pane-heading"><span>FILES</span><small>{files.length}</small></div>{files.map((file) => <button type="button" key={file.path} onClick={() => { setSelectedFile(file.path); setCanvasTab("file"); }} className={file.path === selectedFile ? "file-item active" : "file-item"}>{file.path}</button>)}</section>
          <section className="revision-list"><div className="pane-heading"><span>REVISIONS</span><small>{revisions.length}</small></div>{revisions.slice(0, 4).map((revision) => <div className="revision-item" key={revision.id}>{revision.summary || "Workspace revision"}</div>)}</section>
        </aside>

        <section className="conversation-pane">
          <div className="run-toolbar"><div><span className="eyebrow">任务转录</span><h1>{run ? run.prompt : "从 Workspace 开始"}</h1></div>{run && <div className="run-toolbar-meta"><span className={`run-phase ${run.status}`}>{runPhase(run.status)}</span>{streamState === "reconnecting" && <span className="stream-state reconnecting">连接恢复中</span>}{streamState === "live" && ["queued", "running", "waiting_approval"].includes(run.status) && <span className="stream-state live">实时</span>}<span>{run.mode.toUpperCase()} · {run.model}</span>{["running", "queued"].includes(run.status) && <button type="button" className="icon-command" title="停止任务" onClick={() => void cancelRun()}>■</button>}</div>}</div>
          <div className="conversation-scroll">
            {!run && <div className="agent-intro"><span className="eyebrow">{mode === "build" ? "BUILD MODE" : "PLAN MODE"}</span><h1>{mode === "build" ? "先生成，再确认提交" : "从 Workspace 开始"}</h1><p>{mode === "build" ? "Agent 会把文件修改暂存为可审查的提案。批准前，Workspace 当前版本不会变化。" : "我可以列出、读取和搜索当前 Workspace 的文本文件，并给出可核实的中文方案。"}</p></div>}
            {run && <article className="user-message"><span>你的任务</span><p>{run.prompt}</p></article>}
            {projection.transcript.map((entry) => {
              if (entry.kind === "tool") {
                const tool = projection.tools.find((item) => item.id === entry.id);
                return tool ? <ToolCard key={`tool-${tool.id}`} tool={tool} onOpenArtifact={openToolArtifact} /> : null;
              }
              const message = projection.messages.find((item) => item.id === entry.id);
              return message ? <article className={`agent-message ${message.completed ? "completed" : "streaming"}`} key={`message-${message.id}`}><span>Agent {message.completed ? "" : "正在生成"}</span><p>{message.text}{!message.completed && <i className="stream-cursor" aria-label="正在生成" />}</p></article> : null;
            })}
            {run?.status === "waiting_approval" && <div className="run-note approval-note">Agent 已完成变更提案。请在右侧差异画布审查并决定是否提交。</div>}
            {run?.status === "failed" && <div className="run-note">任务未完成。{run.failureCode === "INSUFFICIENT_CREDITS" ? "余额不足，请前往 m.zmzai.cloud 提额。" : "请检查模型、Relay 或 Workspace 后重试。"}</div>}
            {run?.status === "succeeded" && <div className="run-note completed-note">任务已完成。执行过程与上下文已保留。</div>}
          </div>
          <form className="prompt-composer" onSubmit={startRun}>
            <div className="composer-controls"><div className="mode-switch" role="group" aria-label="任务模式"><button type="button" className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")} disabled={Boolean(run && ["queued", "running", "waiting_approval"].includes(run.status))}>PLAN</button><button type="button" className={mode === "build" ? "active" : ""} onClick={() => setMode("build")} disabled={Boolean(run && ["queued", "running", "waiting_approval"].includes(run.status))}>BUILD</button></div><select value={model} onChange={(event) => setModel(event.target.value)} disabled={!models.length || !workspace}>{models.length ? models.map((item) => <option key={item.model} value={item.model}>{item.model}</option>) : <option>模型目录不可用</option>}</select></div>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={workspace ? mode === "build" ? "描述要创建或修改的应用..." : "描述要分析、梳理或规划的任务..." : "先选择或创建 Workspace"} disabled={!workspace} rows={3} />
            <div className="composer-actions"><span>{mode === "build" ? "暂存权限 · list / read / search / write / edit" : "只读权限 · list / read / search"}</span>{run && ["queued", "running"].includes(run.status) ? <button type="button" className="command-button quiet" onClick={() => void cancelRun()}>停止</button> : <button type="submit" className="command-button" disabled={!workspace || !prompt.trim() || !model || Boolean(run && ["waiting_approval"].includes(run.status))}>开始 {mode === "build" ? "Build" : "Plan"}</button>}</div>
          </form>
        </section>

        <aside className="canvas-pane">
          <div className="pane-heading"><span>上下文画布</span><span className={canvasFollow ? "canvas-live" : "canvas-pinned"}>{canvasFollow ? "跟随执行" : "已固定"}</span></div>
          <div className="canvas-tabs"><button type="button" className={canvasTab === "task" ? "active" : ""} onClick={() => { setCanvasFollow(false); setCanvasTab("task"); }}>任务</button><button type="button" className={canvasTab === "file" ? "active" : ""} onClick={() => { setCanvasFollow(false); setSelectedFile(selectedFile ?? files[0]?.path ?? null); setCanvasTab("file"); }}>文件</button>{proposals.length > 0 && <button type="button" className={canvasTab === "proposal" ? "active" : ""} onClick={() => { setCanvasFollow(false); setCanvasTab("proposal"); }}>差异 <span>{proposals.length}</span></button>}{activeArtifact && <button type="button" className={canvasTab === "artifact" ? "active" : ""} onClick={() => setCanvasTab("artifact")}>执行</button>}</div>
          {!canvasFollow && <button type="button" className="follow-canvas" onClick={() => { setCanvasFollow(true); setPinnedArtifactId(null); setCanvasTab(activeArtifact ? "artifact" : "task"); }}>跟随最新执行</button>}
          {canvasTab === "proposal" && selectedProposal ? <section className="proposal-canvas"><div className="proposal-head"><div><span className="canvas-index">提案</span><h2>{selectedProposal.summary}</h2></div><span className={`proposal-status ${selectedProposal.status}`}>{selectedProposal.status === "pending" ? "待审批" : selectedProposal.status === "approved" ? "已提交" : selectedProposal.status === "rejected" ? "已拒绝" : "已过期"}</span></div><div className="proposal-files">{selectedProposal.changes.map((change) => <button type="button" key={change.path} className="proposal-file" onClick={() => { setSelectedFile(change.path); }}><span>{change.operation === "create" ? "+" : change.operation === "delete" ? "-" : "~"}</span>{change.path}</button>)}</div><pre className="diff-preview">{selectedProposal.diff}</pre>{selectedProposal.status === "pending" && <div className="proposal-actions"><button type="button" className="command-button quiet" disabled={run?.status !== "waiting_approval" || resolvingProposal !== null} onClick={() => void resolveSelectedProposal("reject")}>{resolvingProposal === "reject" ? "拒绝中" : "拒绝"}</button><button type="button" className="command-button" disabled={run?.status !== "waiting_approval" || resolvingProposal !== null} onClick={() => void resolveSelectedProposal("approve")}>{resolvingProposal === "approve" ? "提交中" : "批准并提交"}</button></div>}<p className="proposal-note">{selectedProposal.status === "pending" ? run?.status === "waiting_approval" ? "批准会创建一个不可变 Revision，并推进 Workspace 当前版本。" : "Agent 仍在生成提案，完成后才可审批。" : selectedProposal.status === "superseded" ? "Workspace 已推进到新版本。请重新运行 Build 生成新的提案。" : selectedProposal.status === "approved" ? `已提交为 ${selectedProposal.approvedRevisionId ?? "新版本"}。` : "提案被拒绝，Workspace 文件未改变。"}</p></section> : canvasTab === "file" && currentFile ? <section className="file-preview"><div className="file-preview-title">{currentFile.path}</div><pre>{currentFile.content || "此文件为空。"}</pre></section> : canvasTab === "artifact" && activeArtifact ? <ArtifactView artifact={activeArtifact} /> : <section className="task-canvas"><span className="canvas-index">01</span><h2>{workspace?.name ?? "未选择 Workspace"}</h2><dl><div><dt>模式</dt><dd>{run?.mode === "build" ? "提案式 Build" : "只读 Plan"}</dd></div><div><dt>模型</dt><dd>{model || "未选择"}</dd></div><div><dt>文件</dt><dd>{files.length} 项</dd></div><div><dt>版本</dt><dd>{workspace?.currentRevisionId ? "当前版本" : "尚未创建"}</dd></div></dl><p>画布仅投影 Workspace、任务与事件的持久化状态。</p></section>}
        </aside>
      </div>
    </main>
  );
}
