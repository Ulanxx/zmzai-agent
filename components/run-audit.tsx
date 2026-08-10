"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Workspace = { id: string; name: string };
type AuditRange = "24h" | "7d" | "30d";
type RunStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
type AuditRun = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  mode: "plan" | "build";
  model: string;
  prompt: string;
  status: RunStatus;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  toolCount: number;
  failedToolCount: number;
};
type AuditToolCall = {
  toolCallId: string;
  name: string;
  status: "requested" | "running" | "completed" | "failed";
  argsSummary: string;
  label: string;
  resultSummary: { text: string; truncated: boolean; omittedBytes: number } | null;
  durationMs: number | null;
  requestedAt: string;
  completedAt: string | null;
};
type AuditArtifact = {
  artifactId: string;
  toolCallId: string | null;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  truncated: boolean;
  omittedBytes: number;
  createdAt: string;
};
type AuditDetail = { run: AuditRun; toolCalls: AuditToolCall[]; artifacts: AuditArtifact[] };
type TaskEvent = { id: string; sequence: number; type: string; at: string; data: Record<string, unknown> };
type StreamState = "idle" | "live" | "reconnecting" | "closed";

const activeStatuses: RunStatus[] = ["queued", "running", "waiting_approval"];
const terminalStatuses: RunStatus[] = ["succeeded", "failed", "cancelled"];
const statusOptions: Array<{ value: string; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "queued", label: "排队中" },
  { value: "running", label: "运行中" },
  { value: "waiting_approval", label: "等待审批" },
  { value: "succeeded", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
];
const rangeOptions: Array<{ value: AuditRange; label: string }> = [
  { value: "24h", label: "最近 24 小时" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "请求失败，请稍后重试");
  return body as T;
}

function runPhase(status: string): string {
  if (status === "running" || status === "queued") return "进行中";
  if (status === "waiting_approval") return "等待审批";
  if (status === "succeeded") return "已完成";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return "失败";
  return "待开始";
}

function durationLabel(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s`;
}

function runTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function eventSummary(data: Record<string, unknown>): AuditToolCall["resultSummary"] {
  const value = data.resultSummary;
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
    const summary = value as { text: string; truncated?: unknown; omittedBytes?: unknown };
    return { text: summary.text, truncated: summary.truncated === true, omittedBytes: typeof summary.omittedBytes === "number" ? summary.omittedBytes : 0 };
  }
  return null;
}

function ArtifactPreview({ artifact }: { artifact: AuditArtifact }) {
  const payload = artifact.payload;
  if (artifact.kind === "file_preview") {
    return <section className="audit-artifact-preview"><div className="audit-artifact-head"><span className="canvas-index">文件</span><h3>{artifact.title}</h3></div><pre>{typeof payload.content === "string" ? payload.content : "文件内容不可用"}</pre>{payload.truncated === true && <p className="artifact-note">预览已截断，完整内容仍保留在 Workspace。</p>}</section>;
  }
  if (artifact.kind === "search_results") {
    return <section className="audit-artifact-preview"><div className="audit-artifact-head"><span className="canvas-index">检索</span><h3>{artifact.title}</h3></div><ol className="search-results">{Array.isArray(payload.matches) ? payload.matches.map((match, index) => { const item = match && typeof match === "object" ? match as Record<string, unknown> : {}; return <li key={`${String(item.path)}-${index}`}><span>{String(item.path ?? "文件")}:{String(item.line ?? "")}</span><p>{String(item.text ?? "")}</p></li>; }) : <li>没有可显示的命中。</li>}</ol>{payload.truncated === true && <p className="artifact-note">仅显示前 20 条命中。</p>}</section>;
  }
  return <section className="audit-artifact-preview"><div className="audit-artifact-head"><span className="canvas-index">输出</span><h3>{artifact.title}</h3></div><pre>{typeof payload.content === "string" ? payload.content : "等待输出"}</pre></section>;
}

export function RunAudit() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [filters, setFilters] = useState<{ range: AuditRange; workspaceId: string; status: string }>({ range: "7d", workspaceId: "", status: "" });
  const [runs, setRuns] = useState<AuditRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());
  const eventSource = useRef<EventSource | null>(null);
  const filtersRef = useRef(filters);
  const detailRequest = useRef(0);

  const selectedArtifact = useMemo(() => detail?.artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? null, [detail, selectedArtifactId]);
  const isActive = Boolean(detail && activeStatuses.includes(detail.run.status));

  const closeEvents = useCallback(() => {
    eventSource.current?.close();
    eventSource.current = null;
    setStreamState("closed");
  }, []);

  const loadList = useCallback(async (input: { range: AuditRange; workspaceId: string; status: string; cursor?: string | null; append?: boolean }) => {
    const search = new URLSearchParams({ range: input.range, limit: "30" });
    if (input.workspaceId) search.set("workspaceId", input.workspaceId);
    if (input.status) search.set("status", input.status);
    if (input.cursor) search.set("cursor", input.cursor);
    const result = await requestJson<{ runs: AuditRun[]; nextCursor: string | null }>(`/api/audit/runs?${search.toString()}`);
    if (input.append) {
      setRuns((current) => [...current, ...result.runs]);
    } else {
      setRuns(result.runs);
    }
    setNextCursor(result.nextCursor);
  }, []);

  const applyFilters = useCallback((next: Partial<{ range: AuditRange; workspaceId: string; status: string }>) => {
    setFilters((current) => ({ ...current, ...next }));
    setSelectedId(null);
    setDetail(null);
    setSelectedArtifactId(null);
    setError(null);
    detailRequest.current += 1;
    closeEvents();
  }, [closeEvents]);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    void (async () => {
      try {
        await loadList(filters);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法加载运行审计");
      } finally {
        setListLoading(false);
      }
    })();
  }, [filters, loadList]);

  const applyEvent = useCallback((runId: string, event: TaskEvent) => {
    const data = event.data ?? {};
    const runStatus: Record<string, RunStatus> = {
      "run.started": "running",
      "run.waiting_approval": "waiting_approval",
      "run.completed": "succeeded",
      "run.failed": "failed",
      "run.cancelled": "cancelled",
    };
    const nextRunStatus = runStatus[event.type];
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : null;
    setDetail((current) => {
      if (!current) return current;
      let toolCalls = current.toolCalls;
      if (event.type === "tool.requested" && toolCallId) {
        const existing = toolCalls.find((tool) => tool.toolCallId === toolCallId);
        if (existing) {
          toolCalls = toolCalls.map((tool) => tool.toolCallId === toolCallId ? { ...tool, name: typeof data.name === "string" ? data.name : tool.name, argsSummary: typeof data.argsSummary === "string" ? data.argsSummary : tool.argsSummary, status: "requested" as const } : tool);
        } else {
          toolCalls = [...toolCalls, {
            toolCallId,
            name: typeof data.name === "string" ? data.name : "tool",
            argsSummary: typeof data.argsSummary === "string" ? data.argsSummary : typeof data.name === "string" ? data.name : "tool",
            label: "等待执行",
            status: "requested" as const,
            resultSummary: null,
            durationMs: null,
            requestedAt: event.at,
            completedAt: null,
          }];
        }
      }
      if ((event.type === "tool.progress" || event.type === "tool.completed" || event.type === "tool.failed") && toolCallId) {
        const existing = toolCalls.find((tool) => tool.toolCallId === toolCallId);
        if (existing) {
          toolCalls = toolCalls.map((tool) => tool.toolCallId === toolCallId ? {
            ...tool,
            name: typeof data.name === "string" ? data.name : tool.name,
            status: event.type === "tool.progress" ? "running" as const : event.type === "tool.failed" ? "failed" as const : "completed" as const,
            label: event.type === "tool.progress" ? (typeof data.label === "string" ? data.label : "正在执行") : event.type === "tool.failed" ? "执行失败" : "已完成",
            resultSummary: event.type === "tool.progress" ? tool.resultSummary : eventSummary(data),
            durationMs: event.type === "tool.progress" ? tool.durationMs : (typeof data.durationMs === "number" ? data.durationMs : tool.durationMs),
            completedAt: event.type === "tool.progress" ? tool.completedAt : event.at,
          } : tool);
        }
      }
      let artifacts = current.artifacts;
      if (event.type === "artifact.upsert" && typeof data.artifactId === "string") {
        const payload = data.payload && typeof data.payload === "object" && !Array.isArray(data.payload) ? data.payload as Record<string, unknown> : {};
        const existing = artifacts.find((artifact) => artifact.artifactId === data.artifactId);
        const artifact: AuditArtifact = {
          artifactId: data.artifactId,
          toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : existing?.toolCallId ?? null,
          kind: typeof data.kind === "string" ? data.kind : "unknown",
          title: typeof data.title === "string" ? data.title : "运行上下文",
          payload,
          truncated: payload.truncated === true,
          omittedBytes: typeof payload.omittedBytes === "number" ? payload.omittedBytes : 0,
          createdAt: existing?.createdAt ?? event.at,
        };
        artifacts = existing ? artifacts.map((item) => item.artifactId === artifact.artifactId ? artifact : item) : [...artifacts, artifact];
      }
      return nextRunStatus ? { run: { ...current.run, status: nextRunStatus, failureCode: event.type === "run.failed" && typeof data.code === "string" ? data.code : current.run.failureCode }, toolCalls, artifacts } : { ...current, toolCalls, artifacts };
    });
    if (nextRunStatus) {
      setRuns((current) => current.map((item) => item.id === runId ? { ...item, status: nextRunStatus } : item));
    }
    if (terminalStatuses.includes(nextRunStatus)) {
      closeEvents();
      void loadList({ ...filtersRef.current, cursor: null }).catch(() => undefined);
    }
  }, [closeEvents, loadList]);

  const subscribe = useCallback((runId: string) => {
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
        applyEvent(runId, event);
      } catch { setError("任务事件格式无效"); }
    };
    source.onmessage = handleEvent;
    source.onerror = () => {
      if (eventSource.current !== source) return;
      setStreamState("reconnecting");
    };
  }, [applyEvent, closeEvents]);

  const selectRun = useCallback(async (run: AuditRun) => {
    closeEvents();
    const request = detailRequest.current + 1;
    detailRequest.current = request;
    setSelectedId(run.id);
    setDetail(null);
    setDetailLoading(true);
    setSelectedArtifactId(null);
    setError(null);
    setStreamState("idle");
    try {
      const result = await requestJson<AuditDetail>(`/api/runs/${run.id}/audit`);
      if (detailRequest.current !== request) return;
      setDetail(result);
      if (activeStatuses.includes(result.run.status)) subscribe(result.run.id);
    } catch (cause) {
      if (detailRequest.current === request) setError(cause instanceof Error ? cause.message : "无法读取运行详情");
    } finally {
      if (detailRequest.current === request) setDetailLoading(false);
    }
  }, [closeEvents, subscribe]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    void loadList({ ...filtersRef.current, cursor: nextCursor, append: true })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法加载更多记录"))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, loadList, nextCursor]);

  useEffect(() => {
    void (async () => {
      try {
        const result = await requestJson<{ workspaces: Workspace[] }>("/api/workspaces");
        setWorkspaces(result.workspaces);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法加载 Workspace 列表");
      }
    })();
    return closeEvents;
  }, [closeEvents]);

  useEffect(() => {
    if (!isActive || !detail?.run.startedAt) return;
    const timer = setInterval(() => setLiveNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [detail?.run.startedAt, isActive]);

  const detailDuration = !detail?.run.startedAt
    ? null
    : activeStatuses.includes(detail.run.status)
      ? liveNow - new Date(detail.run.startedAt).getTime()
      : detail.run.durationMs;

  return (
    <main className="audit-page">
      <header className="audit-header">
        <nav className="audit-header-nav" aria-label="主导航">
          <Link href="/" className="audit-brand"><span className="agent-mark">使</span><span className="font-mono text-sm font-bold tracking-[0.08em]">ZMZAI AGENT</span></Link>
          <Link href="/" className="audit-nav-link">工作台</Link>
          <Link href="/audit" className="audit-nav-link active">运行审计</Link>
        </nav>
        <div className="workbench-status"><span className="status-dot" />RUN AUDIT <span className="header-domain">a.zmzai.cloud</span></div>
      </header>
      {error && <div className="workbench-alert">{error}</div>}

      <div className="audit-grid">
        <aside className="audit-list-pane">
          <div className="pane-heading"><span>运行审计</span><small>{runs.length}</small></div>
          <div className="audit-filters">
            <select value={filters.workspaceId} onChange={(event) => applyFilters({ workspaceId: event.target.value })} aria-label="筛选 Workspace">
              <option value="">全部 Workspace</option>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
            <select value={filters.status} onChange={(event) => applyFilters({ status: event.target.value })} aria-label="筛选运行状态">
              {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select value={filters.range} onChange={(event) => applyFilters({ range: event.target.value as AuditRange })} aria-label="筛选时间范围">
              {rangeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          {listLoading ? <p className="empty-state">正在加载任务记录...</p> : runs.length === 0 ? <p className="empty-state">所选范围内没有任务记录。</p> : (
            <>
              <nav className="audit-run-list" aria-label="运行记录">
                {runs.map((run) => (
                  <button type="button" key={run.id} className={run.id === selectedId ? "audit-run-row active" : "audit-run-row"} onClick={() => void selectRun(run)}>
                    <span className="audit-run-row-top"><span className={`run-history-status ${run.status}`}>{runPhase(run.status)}</span><span className="audit-run-workspace">{run.workspaceName}</span><small>{run.mode.toUpperCase()} · {runTimeLabel(run.createdAt)}</small></span>
                    <strong>{run.prompt}</strong>
                    <small>{run.model} · {durationLabel(run.durationMs)} · 工具 {run.toolCount}{run.failedToolCount > 0 ? ` / 失败 ${run.failedToolCount}` : ""}</small>
                  </button>
                ))}
              </nav>
              {nextCursor && <button type="button" className="audit-load-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "加载中..." : "加载更多"}</button>}
            </>
          )}
        </aside>

        <section className="audit-detail-pane">
          {detailLoading && <p className="empty-state">正在读取运行详情...</p>}
          {!detailLoading && !detail && <div className="audit-detail-empty"><span className="canvas-index">AUDIT</span><h2>选择一条运行记录</h2><p>展开任务可查看工具调用时间线、失败原因、执行时长与关联产物。历史记录从持久化投影恢复，不依赖实时连接。</p></div>}
          {!detailLoading && detail && (
            <>
              <div className="audit-detail-head">
                <div><span className="eyebrow">运行详情</span><h1>{detail.run.prompt}</h1></div>
                <div className="run-toolbar-meta">
                  <span className={`run-phase ${detail.run.status}`}>{runPhase(detail.run.status)}</span>
                  {streamState === "reconnecting" && <span className="stream-state reconnecting">连接恢复中</span>}
                  {streamState === "live" && activeStatuses.includes(detail.run.status) && <span className="stream-state live">实时</span>}
                  <span>{detail.run.mode.toUpperCase()} · {detail.run.model}</span>
                  <span>耗时 {durationLabel(detailDuration)}</span>
                </div>
              </div>
              {detail.run.status === "failed" && <div className="audit-failure">任务未完成。{detail.run.failureCode ? `失败码：${detail.run.failureCode}。` : ""}{detail.run.failureCode === "INSUFFICIENT_CREDITS" ? "余额不足，请前往 m.zmzai.cloud 提额。" : "错误摘要已脱敏，请检查模型、Relay 或 Workspace 后重试。"}</div>}
              {detail.run.status === "succeeded" && <div className="run-note completed-note">任务已完成。执行过程与上下文已保留。</div>}

              <div className="audit-detail-section"><div className="pane-heading"><span>工具调用时间线</span><small>{detail.toolCalls.length}</small></div>
                {detail.toolCalls.length === 0 ? <p className="empty-state">暂未产生工具调用。</p> : (
                  <ol className="audit-tool-timeline">
                    {detail.toolCalls.map((tool) => (
                      <li key={tool.toolCallId} className={`audit-tool-node ${tool.status}`}>
                        <div className="audit-tool-node-head">
                          <span className="audit-tool-name">{tool.name}</span>
                          <span className="audit-tool-args">{tool.argsSummary}</span>
                          <span className="audit-tool-state">{tool.status === "requested" ? "准备中" : tool.status === "running" ? "执行中" : tool.status === "failed" ? "失败" : "完成"}</span>
                          <span className="audit-tool-duration">{durationLabel(tool.durationMs)}</span>
                        </div>
                        <p className="audit-tool-body">{tool.status === "failed" && tool.resultSummary ? `错误：${tool.resultSummary.text}` : tool.resultSummary?.text ?? (tool.label || "—")}</p>
                        {tool.resultSummary?.truncated && <p className="audit-tool-truncated">结果已截断，省略 {tool.resultSummary.omittedBytes} B</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div className="audit-detail-section"><div className="pane-heading"><span>关联产物</span><small>{detail.artifacts.length}</small></div>
                {detail.artifacts.length === 0 ? <p className="empty-state">没有关联产物。</p> : (
                  <>
                    <nav className="audit-artifact-list" aria-label="关联产物">
                      {detail.artifacts.map((artifact) => (
                        <button type="button" key={artifact.artifactId} className={artifact.artifactId === selectedArtifactId ? "audit-artifact active" : "audit-artifact"} onClick={() => setSelectedArtifactId(artifact.artifactId)}>
                          <span>{artifact.kind}</span><strong>{artifact.title}</strong>{artifact.truncated && <small>已截断</small>}
                        </button>
                      ))}
                    </nav>
                    {selectedArtifact && <ArtifactPreview artifact={selectedArtifact} />}
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
