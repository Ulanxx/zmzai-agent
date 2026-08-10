"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DiffView } from "@/components/diff-view";
import { Markdown } from "@/components/markdown";
import { projectTaskEvents, type CanvasArtifact, type TaskEvent, type ToolNode } from "@/lib/task-event-projection";

type Workspace = { id: string; name: string; description: string; defaultModel: string; currentRevisionId: string | null; updatedAt: string };
type WorkspaceFile = { path: string; content: string; revisionId: string | null; updatedAt: string };
type Revision = { id: string; summary: string; createdAt: string; changes: Array<{ path: string }> };
type Model = { model: string; maxOutputTokens: number };
type Run = { id: string; workspaceId: string; sessionId: string; mode: "plan" | "build"; model: string; prompt: string; status: string; failureCode: string | null; parentRunId: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string };
type ProposalChange = { path: string; operation: "create" | "update" | "delete"; before: string | null; after: string | null };
type Proposal = {
  id: string;
  runId: string;
  baseRevisionId: string | null;
  status: "pending" | "approved" | "rejected" | "superseded";
  approvedRevisionId: string | null;
  summary: string;
  diff?: string;
  changes?: ProposalChange[];
  kind: "change" | "exec";
  // exec-only fields
  toolCallId?: string;
  program?: string;
  args?: string[];
  cwd?: string | null;
  snapshotSummary?: { revisionId: string | null; fileCount: number; totalBytes: number; files: string[] };
  sandboxRunId?: string | null;
  resultSummary?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  createdAt: string;
  updatedAt: string;
};
type CanvasTab = "task" | "file" | "proposal" | "artifact";
type StreamState = "idle" | "live" | "reconnecting" | "closed";
type TurnProjection = { run: Run; events: TaskEvent[]; projection: ReturnType<typeof projectTaskEvents> };

const activeRunStates = ["queued", "running", "waiting_approval"];
const terminalRunStates = ["succeeded", "failed", "cancelled"];

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

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

/** Reads a terminal run's full event history over its SSE stream (which closes
 *  at terminal state) and resolves with the collected events. */
function fetchRunEvents(runId: string): Promise<TaskEvent[]> {
  return new Promise((resolve) => {
    const events: TaskEvent[] = [];
    const source = new EventSource(`/api/runs/${runId}/events`);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      source.close();
      resolve(events);
    };
    source.onmessage = (messageEvent) => {
      try {
        const event = JSON.parse(messageEvent.data) as TaskEvent;
        events.push(event);
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) finish();
      } catch { /* ignore malformed frames */ }
    };
    source.onerror = () => finish();
    window.setTimeout(finish, 10_000);
  });
}

function ToolCard({ tool, onOpenArtifact }: { tool: ToolNode; onOpenArtifact: (toolCallId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const running = tool.status === "requested" || tool.status === "running";
  return <article className={`tool-card ${tool.status}`}>
    <div className="tool-card-head">
      <div className="tool-card-title"><span className={`tool-card-indicator ${tool.status}`} aria-hidden>{tool.status === "completed" ? "✓" : tool.status === "failed" ? "✗" : ""}</span><span className="tool-card-name">{tool.name}</span><span className="tool-card-args">{tool.argsSummary}</span></div>
      <span className="tool-card-state">{running ? (tool.status === "requested" ? "准备中" : "执行中") : tool.status === "failed" ? "失败" : "完成"}</span>
    </div>
    <div className="tool-card-body"><span>{tool.resultSummary?.text ?? tool.label}</span><span className="tool-card-meta">{durationLabel(tool.durationMs)}</span></div>
    {tool.resultSummary?.truncated && <p className="tool-card-truncated">结果已截断，省略 {tool.resultSummary.omittedBytes} B</p>}
    <div className="tool-card-actions">{tool.resultSummary && <button type="button" className="tool-card-open" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起结果" : "展开结果"}</button>}{tool.status !== "requested" && <button type="button" className="tool-card-open" onClick={() => onOpenArtifact(tool.id)}>查看上下文</button>}</div>
    {expanded && tool.resultSummary && <pre className="tool-card-detail">{tool.resultSummary.text}</pre>}
  </article>;
}

function ArtifactView({ artifact }: { artifact: CanvasArtifact }) {
  const payload = artifact.payload;
  if (artifact.kind === "file_preview") return <section className="artifact-canvas"><div className="artifact-head"><span className="canvas-index">文件</span><h2>{artifact.title}</h2></div><pre>{typeof payload.content === "string" ? payload.content : "文件内容不可用"}</pre>{payload.truncated === true && <p className="artifact-note">预览已截断，完整内容仍保留在 Workspace。</p>}</section>;
  if (artifact.kind === "search_results") return <section className="artifact-canvas"><div className="artifact-head"><span className="canvas-index">检索</span><h2>{artifact.title}</h2></div><ol className="search-results">{Array.isArray(payload.matches) ? payload.matches.map((match, index) => { const item = match && typeof match === "object" ? match as Record<string, unknown> : {}; return <li key={`${String(item.path)}-${index}`}><span>{String(item.path ?? "文件")}:{String(item.line ?? "")}</span><p>{String(item.text ?? "")}</p></li>; }) : <li>没有可显示的命中。</li>}</ol>{payload.truncated === true && <p className="artifact-note">仅显示前 20 条命中。</p>}</section>;
  return <section className="artifact-canvas"><div className="artifact-head"><span className="canvas-index">{artifact.kind === "execution_output" ? "执行" : "输出"}</span><h2>{artifact.title}</h2></div><pre className={artifact.kind === "execution_output" ? "exec-output" : undefined}>{typeof payload.content === "string" ? payload.content : "等待输出"}</pre>{payload.truncated === true && <p className="artifact-note">输出已截断，完整内容保留在服务端受控日志。</p>}</section>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function proposalStatusLabel(status: Proposal["status"]): string {
  if (status === "pending") return "待审批";
  if (status === "approved") return "已批准";
  if (status === "rejected") return "已拒绝";
  return "已过期";
}

function ExecProposalView({ proposal, run, resolvingProposal, onResolve }: { proposal: Proposal; run: Run | null; resolvingProposal: "approve" | "reject" | null; onResolve: (action: "approve" | "reject") => void }) {
  const commandLabel = [proposal.program ?? "", ...(proposal.args ?? [])].join(" ");
  const snapshot = proposal.snapshotSummary;
  return <section className="proposal-canvas">
    <div className="proposal-head">
      <div><span className="canvas-index">执行提案</span><h2>{commandLabel || proposal.summary}</h2></div>
      <span className={`proposal-status ${proposal.status}`}>{proposalStatusLabel(proposal.status)}</span>
    </div>
    <dl className="exec-proposal-meta">
      <div><dt>程序</dt><dd className="mono">{proposal.program ?? "—"}</dd></div>
      {proposal.args && proposal.args.length > 0 && <div><dt>参数</dt><dd className="mono">{proposal.args.map((arg) => `"${arg}"`).join(" ")}</dd></div>}
      {proposal.cwd && <div><dt>工作目录</dt><dd className="mono">{proposal.cwd}</dd></div>}
      <div><dt>影子快照</dt><dd>{snapshot ? `${snapshot.fileCount} 个文件 · ${formatBytes(snapshot.totalBytes)}${snapshot.revisionId ? ` · 版本 ${snapshot.revisionId}` : " · 草稿"}` : "—"}</dd></div>
    </dl>
    {snapshot && snapshot.files.length > 0 && <details className="exec-snapshot-files"><summary>快照文件清单（{snapshot.files.length}）</summary><ol>{snapshot.files.map((path) => <li key={path} className="mono">{path}</li>)}</ol></details>}
    {proposal.resultSummary && <pre className="tool-card-detail">{proposal.resultSummary}</pre>}
    {proposal.status === "pending" && <div className="proposal-actions"><button type="button" className="command-button quiet" disabled={run?.status !== "waiting_approval" || resolvingProposal !== null} onClick={() => onResolve("reject")}>{resolvingProposal === "reject" ? "拒绝中" : "拒绝"}</button><button type="button" className="command-button" disabled={run?.status !== "waiting_approval" || resolvingProposal !== null} onClick={() => onResolve("approve")}>{resolvingProposal === "approve" ? "提交中" : "批准并执行"}</button></div>}
    <p className="proposal-note">{proposal.status === "pending" ? run?.status === "waiting_approval" ? "批准后命令会在隔离沙箱中运行，基于以上影子快照（含未批准的变更），输出实时返回。" : "Agent 仍在生成执行提案，完成后才可审批。" : proposal.status === "approved" ? (proposal.exitCode !== null ? `执行完成 · 退出码 ${proposal.exitCode}${proposal.durationMs ? ` · ${durationLabel(proposal.durationMs)}` : ""}` : "执行已批准，正在准备沙箱…") : proposal.status === "rejected" ? "执行被拒绝，命令未运行。" : "执行提案已过期。"}</p>
  </section>;
}

const starterPrompts = [
  { mode: "plan" as const, text: "分析当前 Workspace 的目录结构与核心模块，梳理数据流，并给出可执行的改进方案" },
  { mode: "plan" as const, text: "审查这个项目的技术栈、配置与潜在风险点，列出需要优先处理的问题" },
  { mode: "build" as const, text: "为项目生成一份新的功能改动提案（例如新增健康检查或修复已知问题），先给我看差异再决定是否提交" },
];

export function AgentWorkbench() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [thread, setThread] = useState<Run[]>([]);
  const [runHistory, setRunHistory] = useState<Run[]>([]);
  const [eventsByRunId, setEventsByRunId] = useState<Record<string, TaskEvent[]>>({});
  const [mode, setMode] = useState<"plan" | "build">("plan");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [canvasTab, setCanvasTab] = useState<CanvasTab>("task");
  const [canvasFollow, setCanvasFollow] = useState(true);
  const [pinnedArtifactId, setPinnedArtifactId] = useState<string | null>(null);
  const [resolvingProposal, setResolvingProposal] = useState<"approve" | "reject" | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [followScroll, setFollowScroll] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const eventSource = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const workspace = useMemo(() => workspaces.find((item) => item.id === selectedId) ?? null, [workspaces, selectedId]);
  const run = useMemo(() => thread.at(-1) ?? null, [thread]);
  const activeRun = Boolean(run && activeRunStates.includes(run.status));
  const turns = useMemo<TurnProjection[]>(() => thread.map((item) => ({ run: item, events: eventsByRunId[item.id] ?? [], projection: projectTaskEvents(eventsByRunId[item.id] ?? []) })), [thread, eventsByRunId]);
  const currentTurn = turns.at(-1) ?? null;
  const currentProjection = currentTurn?.projection ?? null;
  const activeArtifact = useMemo(() => canvasFollow ? currentProjection?.artifacts.at(-1) ?? null : currentProjection?.artifacts.find((artifact) => artifact.id === pinnedArtifactId) ?? null, [canvasFollow, pinnedArtifactId, currentProjection]);
  const currentFile = files.find((file) => file.path === selectedFile) ?? null;
  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? proposals[0] ?? null;
  const currentResumed = useMemo(() => currentTurn?.events.some((event) => event.type === "run.resumed") ?? false, [currentTurn]);
  const sandboxRunning = useMemo(() => Boolean(run && run.status === "running" && currentTurn?.projection.tools.some((tool) => tool.name === "exec" && (tool.status === "running" || tool.status === "requested"))), [run, currentTurn]);

  const closeEvents = useCallback(() => {
    eventSource.current?.close();
    eventSource.current = null;
    setStreamState("closed");
  }, []);

  const applyRunStatus = useCallback((runId: string, status: string) => {
    setThread((current) => current.map((item) => item.id === runId ? { ...item, status } : item));
    setRunHistory((current) => current.map((item) => item.id === runId ? { ...item, status } : item));
  }, []);

  const loadWorkspaceContext = useCallback(async (workspaceId: string) => {
    const [fileResult, revisionResult, runResult] = await Promise.all([
      requestJson<{ files: WorkspaceFile[] }>(`/api/workspaces/${workspaceId}/files`),
      requestJson<{ revisions: Revision[] }>(`/api/workspaces/${workspaceId}/revisions`),
      requestJson<{ runs: Run[] }>(`/api/workspaces/${workspaceId}/runs?limit=50`),
    ]);
    setFiles(fileResult.files);
    setRevisions(revisionResult.revisions);
    setRunHistory(runResult.runs);
    setSelectedFile((current) => current && fileResult.files.some((file) => file.path === current) ? current : fileResult.files[0]?.path ?? null);
    return runResult.runs;
  }, []);

  const loadProposals = useCallback(async (runId: string) => {
    const result = await requestJson<{ proposals: Proposal[] }>(`/api/runs/${runId}/proposals`);
    setProposals(result.proposals);
    setSelectedProposalId((current) => current && result.proposals.some((proposal) => proposal.id === current) ? current : result.proposals[0]?.id ?? null);
    return result.proposals;
  }, []);

  const handleTaskEvent = useCallback((runId: string, workspaceId: string, event: TaskEvent, source: EventSource) => {
    setEventsByRunId((current) => {
      const existing = current[runId] ?? [];
      if (existing.some((item) => item.sequence === event.sequence)) return current;
      return { ...current, [runId]: [...existing, event] };
    });
    if (["proposal.created", "proposal.updated", "approval.required"].includes(event.type)) {
      void loadProposals(runId).then((nextProposals) => {
        if (nextProposals.length && canvasFollow) setCanvasTab("proposal");
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法读取提案"));
    }
    if (event.type === "artifact.upsert" && canvasFollow) setCanvasTab("artifact");
    if (event.type === "run.waiting_approval") applyRunStatus(runId, "waiting_approval");
    if (event.type === "run.resumed") {
      applyRunStatus(runId, "running");
      if (canvasFollow) setCanvasTab("task");
    }
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
      const status = event.type === "run.completed" ? "succeeded" : event.type === "run.cancelled" ? "cancelled" : "failed";
      applyRunStatus(runId, status);
      void loadWorkspaceContext(workspaceId).catch(() => undefined);
      source.close();
      if (eventSource.current === source) eventSource.current = null;
      setStreamState("closed");
    }
  }, [applyRunStatus, canvasFollow, loadProposals, loadWorkspaceContext]);

  const subscribe = useCallback((runId: string, workspaceId: string, historicalTerminal = false) => {
    closeEvents();
    const source = new EventSource(`/api/runs/${runId}/events`);
    eventSource.current = source;
    setStreamState("reconnecting");
    source.onopen = () => { if (eventSource.current === source) setStreamState("live"); };
    const handleEvent = (messageEvent: MessageEvent<string>) => {
      try {
        handleTaskEvent(runId, workspaceId, JSON.parse(messageEvent.data) as TaskEvent, source);
      } catch { setError("任务事件格式无效"); }
    };
    for (const type of ["run.queued", "run.started", "run.waiting_approval", "run.resumed", "run.completed", "run.failed", "run.cancelled", "message.started", "message.delta", "message.completed", "tool.requested", "tool.progress", "tool.completed", "tool.failed", "artifact.upsert", "artifact.append", "proposal.created", "proposal.updated", "approval.required", "approval.resolved", "revision.created"]) source.addEventListener(type, handleEvent);
    source.onmessage = handleEvent;
    source.onerror = () => {
      if (eventSource.current !== source) return;
      if (historicalTerminal) {
        source.close();
        eventSource.current = null;
        setStreamState("closed");
        return;
      }
      setStreamState("reconnecting");
    };
  }, [closeEvents, handleTaskEvent]);

  const restoreThread = useCallback(async (runs: Run[]) => {
    if (!runs.length) {
      setThread([]);
      setEventsByRunId({});
      setProposals([]);
      setSelectedProposalId(null);
      setCanvasTab("task");
      setCanvasFollow(true);
      setPinnedArtifactId(null);
      return;
    }
    const latest = runs[0];
    const sessionRuns = runs.filter((item) => item.sessionId === latest.sessionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    setThread(sessionRuns);
    setEventsByRunId({});
    setProposals([]);
    setSelectedProposalId(null);
    setCanvasTab("task");
    setCanvasFollow(true);
    setPinnedArtifactId(null);
    setStreamState("idle");
    const current = sessionRuns.at(-1) ?? null;
    if (current) {
      if (activeRunStates.includes(current.status)) {
        subscribe(current.id, current.workspaceId);
      } else {
        for (const item of sessionRuns) {
          void fetchRunEvents(item.id).then((events) => {
            setEventsByRunId((previous) => previous[item.id] ? previous : { ...previous, [item.id]: events });
          });
        }
      }
      void loadProposals(current.id).catch(() => undefined);
    }
  }, [subscribe, loadProposals]);

  const selectWorkspace = useCallback(async (workspaceId: string) => {
    closeEvents();
    setSelectedId(workspaceId);
    const nextWorkspace = workspaces.find((item) => item.id === workspaceId);
    if (nextWorkspace) setModel(nextWorkspace.defaultModel);
    setError(null);
    try {
      const runs = await loadWorkspaceContext(workspaceId);
      await restoreThread(runs);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取 Workspace"); }
  }, [closeEvents, loadWorkspaceContext, restoreThread, workspaces]);

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
          const runs = await loadWorkspaceContext(first.id);
          await restoreThread(runs);
        } else if (modelResult.status === "fulfilled") {
          setModel(modelResult.value.models[0]?.model ?? "");
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法加载工作台");
      } finally { setLoading(false); }
    })();
    return closeEvents;
  }, [closeEvents, loadWorkspaceContext, restoreThread]);

  // Auto-scroll while following the latest execution.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && followScroll) element.scrollTop = element.scrollHeight;
  }, [eventsByRunId, thread, followScroll]);

  // Live elapsed timer for the current run.
  useEffect(() => {
    if (!run || terminalRunStates.includes(run.status)) return;
    const anchor = run.startedAt ? new Date(run.startedAt).getTime() : new Date(run.createdAt).getTime();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - anchor) / 1000)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status, run?.startedAt, run?.createdAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-grow the composer textarea.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 8 * 1.55 * 16)}px`;
  }, [prompt]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name) { setError("请输入 Workspace 名称"); return; }
    if (!model) { setError("没有可用模型，请先到 m.zmzai.cloud 配置 Relay 模型"); return; }
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

  async function submitPrompt(options?: { overridePrompt?: string; overrideMode?: "plan" | "build" }) {
    if (!workspace) return;
    const nextPrompt = (options?.overridePrompt ?? prompt).trim();
    const nextMode = options?.overrideMode ?? mode;
    if (!nextPrompt || !model || activeRun || sending) return;
    setSending(true);
    setError(null);
    const continuationRunId = run?.id ?? null;
    try {
      const result = await requestJson<{ run: Run }>(`/api/workspaces/${workspace.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestId() },
        body: JSON.stringify({ mode: nextMode, model, prompt: nextPrompt, ...(continuationRunId ? { continueFromRunId: continuationRunId } : {}) }),
      });
      const nextRun = result.run;
      if (continuationRunId) {
        setThread((current) => [...current, nextRun]);
      } else {
        setThread([nextRun]);
        setEventsByRunId({});
        setProposals([]);
        setSelectedProposalId(null);
        setCanvasTab("task");
        setCanvasFollow(true);
        setPinnedArtifactId(null);
      }
      setRunHistory((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]);
      setPrompt("");
      setMode(nextMode);
      subscribe(nextRun.id, workspace.id);
      textareaRef.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动任务");
    } finally { setSending(false); }
  }

  function startNewSession() {
    closeEvents();
    setThread([]);
    setEventsByRunId({});
    setProposals([]);
    setSelectedProposalId(null);
    setCanvasTab("task");
    setCanvasFollow(true);
    setPinnedArtifactId(null);
    setError(null);
    textareaRef.current?.focus();
  }

  async function cancelRun() {
    if (!run) return;
    try {
      const result = await requestJson<{ run: Run }>(`/api/runs/${run.id}/cancel`, { method: "POST", headers: { "idempotency-key": requestId() } });
      applyRunStatus(result.run.id, result.run.status);
      closeEvents();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "取消失败"); }
  }

  async function resolveSelectedProposal(action: "approve" | "reject") {
    if (!workspace || !selectedProposal || resolvingProposal || run?.status !== "waiting_approval") return;
    setResolvingProposal(action);
    setError(null);
    const endpoint = selectedProposal.kind === "exec" ? `/api/executions/${selectedProposal.id}/${action}` : `/api/proposals/${selectedProposal.id}/${action}`;
    try {
      const result = await requestJson<{ proposal: Proposal; revisionId?: string | null }>(endpoint, {
        method: "POST",
        headers: { "idempotency-key": requestId() },
      });
      setProposals((current) => current.map((proposal) => proposal.id === result.proposal.id ? { ...proposal, ...result.proposal } : proposal));
      if (action === "approve" && result.revisionId) {
        setWorkspaces((current) => current.map((item) => item.id === workspace.id ? { ...item, currentRevisionId: result.revisionId ?? item.currentRevisionId } : item));
        void loadWorkspaceContext(workspace.id).catch(() => undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "审批操作失败");
      void loadProposals(selectedProposal.runId).catch(() => undefined);
    } finally { setResolvingProposal(null); }
  }

  function openToolArtifact(toolCallId: string) {
    const artifact = currentProjection?.artifacts.find((item) => item.toolCallId === toolCallId);
    if (!artifact) return;
    setCanvasFollow(false);
    setPinnedArtifactId(artifact.id);
    setCanvasTab("artifact");
  }

  async function openRunHistory(item: Run) {
    closeEvents();
    setError(null);
    const sessionRuns = runHistory.filter((candidate) => candidate.sessionId === item.sessionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    setThread(sessionRuns);
    setEventsByRunId({});
    setProposals([]);
    setSelectedProposalId(null);
    setCanvasTab("task");
    setCanvasFollow(true);
    setPinnedArtifactId(null);
    const current = sessionRuns.at(-1) ?? item;
    if (activeRunStates.includes(current.status)) {
      subscribe(current.id, current.workspaceId);
    } else {
      for (const candidate of sessionRuns) {
        void fetchRunEvents(candidate.id).then((events) => {
          setEventsByRunId((previous) => previous[candidate.id] ? previous : { ...previous, [candidate.id]: events });
        });
      }
    }
    void loadProposals(current.id).catch(() => undefined);
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt();
    }
  };

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
          <section className="run-history"><div className="pane-heading"><span>RUN HISTORY</span><small>{runHistory.length}</small></div>{runHistory.length ? <nav className="run-history-list" aria-label="任务历史">{runHistory.map((item) => <button type="button" key={item.id} className={`${item.id === run?.id ? "run-history-item active" : "run-history-item"}${item.sessionId === run?.sessionId && item.id !== run?.id ? " in-session" : ""}`} onClick={() => openRunHistory(item)}><span className={`run-history-status ${item.status}`}>{runPhase(item.status)}</span><strong>{item.prompt}</strong><small>{runTimeLabel(item.createdAt)} · {item.mode.toUpperCase()}</small></button>)}</nav> : <p className="empty-state">此 Workspace 还没有任务记录。</p>}</section>
          <section className="file-tree"><div className="pane-heading"><span>FILES</span><small>{files.length}</small></div>{files.map((file) => <button type="button" key={file.path} onClick={() => { setSelectedFile(file.path); setCanvasTab("file"); }} className={file.path === selectedFile ? "file-item active" : "file-item"}>{file.path}</button>)}</section>
          <section className="revision-list"><div className="pane-heading"><span>REVISIONS</span><small>{revisions.length}</small></div>{revisions.slice(0, 4).map((revision) => <div className="revision-item" key={revision.id}>{revision.summary || "Workspace revision"}</div>)}</section>
        </aside>

        <section className="conversation-pane">
          <div className="run-toolbar"><div><span className="eyebrow">{thread.length ? "会话转录" : "任务转录"}</span><h1>{run ? run.prompt : "从 Workspace 开始"}</h1></div>{run && <div className="run-toolbar-meta"><span className={`run-phase ${run.status}`}>{runPhase(run.status)}</span>{!terminalRunStates.includes(run.status) && <span className="run-timer">{elapsedLabel(elapsedSeconds)}</span>}{streamState === "reconnecting" && <span className="stream-state reconnecting">连接恢复中</span>}{streamState === "live" && activeRun && <span className="stream-state live">实时</span>}{sandboxRunning && <span className="stream-state live">沙箱执行中</span>}<span>{run.mode.toUpperCase()} · {run.model}</span>{activeRun && <button type="button" className="icon-command" title="停止任务" onClick={() => void cancelRun()}>■</button>}<button type="button" className="icon-command" title="新会话" onClick={startNewSession}>＋</button></div>}</div>
          <div className="conversation-scroll" ref={scrollRef} onScroll={() => {
            const element = scrollRef.current;
            if (!element) return;
            setFollowScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 160);
          }}>
            {!run && <div className="agent-intro"><span className="eyebrow">{mode === "build" ? "BUILD MODE" : "PLAN MODE"}</span><h1>{mode === "build" ? "先生成，再确认提交" : "从 Workspace 开始"}</h1><p>{mode === "build" ? "Agent 会把文件修改暂存为可审查的提案。批准前，Workspace 当前版本不会变化；批准后 Agent 会自动继续。" : "我可以列出、读取和搜索当前 Workspace 的文本文件，并给出可核实的中文方案。任务结束后可以在同一会话继续追问。"}</p><div className="starter-prompts">{starterPrompts.map((item) => <button type="button" key={item.text} onClick={() => { setMode(item.mode); setPrompt(item.text); textareaRef.current?.focus(); }}><span>{item.mode === "build" ? "BUILD" : "PLAN"}</span>{item.text}</button>)}</div></div>}
            {turns.map(({ run: turnRun, projection }, index) => (
              <div className="run-turn" key={turnRun.id}>
                {index > 0 && <div className="turn-divider"><span>第 {index + 1} 轮</span><span>{turnRun.mode.toUpperCase()} · {turnRun.model}</span><span className={`run-phase ${turnRun.status}`}>{runPhase(turnRun.status)}</span></div>}
                <article className="user-message"><span>你的任务</span><p>{turnRun.prompt}</p></article>
                {turnRun.id === run?.id && currentResumed && <div className="run-note resumed-note">提案已处理，Agent 继续执行…</div>}
                {projection.transcript.map((entry) => {
                  if (entry.kind === "tool") {
                    const tool = projection.tools.find((item) => item.id === entry.id);
                    return tool ? <ToolCard key={`tool-${tool.id}`} tool={tool} onOpenArtifact={openToolArtifact} /> : null;
                  }
                  const message = projection.messages.find((item) => item.id === entry.id);
                  return message ? <article className={`agent-message ${message.completed ? "completed" : "streaming"}`} key={`message-${message.id}`}><span>Agent {message.completed ? "" : "正在生成"}</span><Markdown text={message.text} />{!message.completed && <i className="stream-cursor" aria-label="正在生成" />}</article> : null;
                })}
                {turnRun.status === "waiting_approval" && <div className="run-note approval-note">Agent 已生成提案（文件变更或沙箱执行）。请在右侧提案画布审查并决定。</div>}
                {turnRun.status === "failed" && <div className="run-note"><span>任务未完成。{turnRun.failureCode === "INSUFFICIENT_CREDITS" ? "余额不足，请前往 m.zmzai.cloud 提额。" : "请检查模型、Relay 或 Workspace 后重试。"}</span>{index === thread.length - 1 && <button type="button" className="retry-button" onClick={() => void submitPrompt({ overridePrompt: turnRun.prompt, overrideMode: turnRun.mode })}>重试</button>}</div>}
                {turnRun.status === "succeeded" && <div className="run-note completed-note">任务已完成。可以在下方继续追问，或点击「新会话」开始全新任务。</div>}
              </div>
            ))}
            {!followScroll && <button type="button" className="jump-to-latest" onClick={() => { const element = scrollRef.current; if (element) { element.scrollTop = element.scrollHeight; setFollowScroll(true); } }}>跳至最新 ↓</button>}
          </div>
          <form className="prompt-composer" onSubmit={(event) => { event.preventDefault(); void submitPrompt(); }}>
            <div className="composer-controls"><div className="mode-switch" role="group" aria-label="任务模式"><button type="button" className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")} disabled={activeRun}>PLAN</button><button type="button" className={mode === "build" ? "active" : ""} onClick={() => setMode("build")} disabled={activeRun}>BUILD</button></div><select value={model} onChange={(event) => setModel(event.target.value)} disabled={!models.length || !workspace}>{models.length ? models.map((item) => <option key={item.model} value={item.model}>{item.model}</option>) : <option>模型目录不可用</option>}</select></div>
            <textarea ref={textareaRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={workspace ? activeRun ? "Agent 正在执行，完成后可继续…" : thread.length ? "继续这条对话…（Enter 发送，Shift+Enter 换行）" : mode === "build" ? "描述要创建或修改的应用..." : "描述要分析、梳理或规划的任务..." : "先选择或创建 Workspace"} disabled={!workspace} rows={3} />
            <div className="composer-actions"><span>{mode === "build" ? "暂存权限 · list / read / search / write / edit" : "只读权限 · list / read / search"}{thread.length > 0 && <em className="composer-continuation">· 继续会话 {thread.length + 1}</em>}</span>{activeRun ? <button type="button" className="command-button quiet" onClick={() => void cancelRun()}>停止</button> : <button type="submit" className="command-button" disabled={!workspace || !prompt.trim() || !model || sending}>{sending ? "发送中" : thread.length ? "发送" : `开始 ${mode === "build" ? "Build" : "Plan"}`}</button>}</div>
          </form>
        </section>

        <aside className="canvas-pane">
          <div className="pane-heading"><span>上下文画布</span><span className={canvasFollow ? "canvas-live" : "canvas-pinned"}>{canvasFollow ? "跟随执行" : "已固定"}</span></div>
          <div className="canvas-tabs"><button type="button" className={canvasTab === "task" ? "active" : ""} onClick={() => { setCanvasFollow(false); setCanvasTab("task"); }}>任务</button><button type="button" className={canvasTab === "file" ? "active" : ""} onClick={() => { setCanvasFollow(false); setSelectedFile(selectedFile ?? files[0]?.path ?? null); setCanvasTab("file"); }}>文件</button>{proposals.length > 0 && <button type="button" className={canvasTab === "proposal" ? "active" : ""} onClick={() => { setCanvasFollow(false); setCanvasTab("proposal"); }}>提案 <span>{proposals.length}</span></button>}{activeArtifact && <button type="button" className={canvasTab === "artifact" ? "active" : ""} onClick={() => setCanvasTab("artifact")}>执行</button>}</div>
          {!canvasFollow && <button type="button" className="follow-canvas" onClick={() => { setCanvasFollow(true); setPinnedArtifactId(null); setCanvasTab(activeArtifact ? "artifact" : "task"); }}>跟随最新执行</button>}
          {canvasTab === "proposal" && selectedProposal ? (selectedProposal.kind === "exec" ? <ExecProposalView proposal={selectedProposal} run={run} resolvingProposal={resolvingProposal} onResolve={(action) => void resolveSelectedProposal(action)} /> : <section className="proposal-canvas"><div className="proposal-head"><div><span className="canvas-index">变更提案</span><h2>{selectedProposal.summary}</h2></div><span className={`proposal-status ${selectedProposal.status}`}>{proposalStatusLabel(selectedProposal.status)}</span></div><div className="proposal-files">{(selectedProposal.changes ?? []).map((change) => <button type="button" key={change.path} className="proposal-file" onClick={() => { setSelectedFile(change.path); }}><span>{change.operation === "create" ? "+" : change.operation === "delete" ? "-" : "~"}</span>{change.path}</button>)}</div><DiffView diff={selectedProposal.diff ?? ""} />{selectedProposal.status === "pending" && <div className="proposal-actions"><button type="button" className="command-button quiet" disabled={run?.status !== "waiting_approval" || resolvingProposal !== null} onClick={() => void resolveSelectedProposal("reject")}>{resolvingProposal === "reject" ? "拒绝中" : "拒绝"}</button><button type="button" className="command-button" disabled={run?.status !== "waiting_approval" || resolvingProposal !== null} onClick={() => void resolveSelectedProposal("approve")}>{resolvingProposal === "approve" ? "提交中" : "批准并提交"}</button></div>}<p className="proposal-note">{selectedProposal.status === "pending" ? run?.status === "waiting_approval" ? "批准会创建一个不可变 Revision，并推进 Workspace 当前版本；Agent 随后自动继续。" : "Agent 仍在生成提案，完成后才可审批。" : selectedProposal.status === "superseded" ? "Workspace 已推进到新版本。请重新运行 Build 生成新的提案。" : selectedProposal.status === "approved" ? `已提交为 ${selectedProposal.approvedRevisionId ?? "新版本"}。` : "提案被拒绝，Workspace 文件未改变。"}</p></section>) : canvasTab === "file" && currentFile ? <section className="file-preview"><div className="file-preview-title">{currentFile.path}</div><pre>{currentFile.content || "此文件为空。"}</pre></section> : canvasTab === "artifact" && activeArtifact ? <ArtifactView artifact={activeArtifact} /> : <section className="task-canvas"><span className="canvas-index">01</span><h2>{workspace?.name ?? "未选择 Workspace"}</h2><dl><div><dt>模式</dt><dd>{run?.mode === "build" ? "提案式 Build" : "只读 Plan"}</dd></div><div><dt>模型</dt><dd>{model || "未选择"}</dd></div><div><dt>文件</dt><dd>{files.length} 项</dd></div><div><dt>版本</dt><dd>{workspace?.currentRevisionId ? "当前版本" : "尚未创建"}</dd></div><div><dt>会话</dt><dd>{thread.length ? `第 ${thread.length} 轮` : "尚未开始"}</dd></div></dl><p>画布仅投影 Workspace、任务与事件的持久化状态。</p></section>}
        </aside>
      </div>
    </main>
  );
}
