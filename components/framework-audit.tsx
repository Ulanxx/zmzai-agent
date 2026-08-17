"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Navbar, navItemClass } from "@zmzai/theme";

/** FW 会话审计：左列会话清单，右列工具时间线 + 事件流。数据源是
 *  fw_sessions + fw_events（framework/core/events/bus.readFrameworkEvents），
 *  取代旧 TaskRun 审计。 */

type AuditRow = {
  sessionId: string;
  title: string;
  workspace: string;
  agent: string;
  model: string;
  toolCalls: number;
  failedTools: number;
  updatedAt: string;
  lastActivity: string;
};

type ToolNode = {
  callId: string;
  tool: string;
  status: string;
  title: string | null;
  output: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

type AuditDetail = {
  session: { id: string; title: string; agent: string; model: { modelId: string } };
  toolTimeline: ToolNode[];
  events: { seq: number; type: string; at: string; data: unknown }[];
};

function timeLabel(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}


export function FrameworkAudit() {
  const pathname = usePathname() ?? "/";
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openEvents, setOpenEvents] = useState<Set<number>>(new Set());

  const toggleEvent = (seq: number) => {
    setOpenEvents((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/audit/sessions", { cache: "no-store" });
        const body = (await response.json()) as { sessions?: AuditRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "无法读取审计列表");
        setRows(body.sessions ?? []);
        setSelected((current) => current ?? body.sessions?.[0]?.sessionId ?? null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法读取审计列表");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) return;
    // 保留旧详情直到新详情到达，避免切换会话时右侧先闪空白。
    queueMicrotask(() => setDetailLoading(true));
    void (async () => {
      try {
        const response = await fetch(`/api/audit/sessions/${encodeURIComponent(selected)}`, { cache: "no-store" });
        const body = (await response.json()) as AuditDetail & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "无法读取会话详情");
        setDetail(body);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法读取会话详情");
      } finally {
        setDetailLoading(false);
      }
    })();
  }, [selected]);

  if (loading) return <main className="workbench-loading">正在读取审计…</main>;

  return (
    <main className="audit-page">
      <Navbar
        sublabel="agent"
        brandHref="/"
        badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">a.zmzai.cloud</span>}
      >
        <Link href="/fw" className={navItemClass(pathname === "/fw")}>工作台</Link>
        <Link href="/audit" className={navItemClass(pathname === "/audit")}>运行审计</Link>
      </Navbar>
      {error && <div className="workbench-alert">{error}</div>}

      <div className="audit-grid">
        <aside className="audit-list-pane">
          <div className="pane-heading">
            <span>会话</span>
            <small>{rows.length}</small>
          </div>
          <div className="audit-run-list">
            {rows.map((row) => (
              <button type="button" key={row.sessionId} className={row.sessionId === selected ? "audit-run-row active" : "audit-run-row"} onClick={() => setSelected(row.sessionId)}>
                <div className="audit-run-row-top">
                  <strong>{row.title}</strong>
                  <small>{timeLabel(row.updatedAt)}</small>
                </div>
                <span className="audit-run-workspace">{row.workspace}</span>
                <small>
                  {row.agent} · {row.toolCalls} 次工具调用{row.failedTools > 0 ? ` · ${row.failedTools} 失败` : ""}
                </small>
              </button>
            ))}
            {!rows.length && <p className="empty-state">还没有 FW 会话。到工作台发起第一个任务。</p>}
          </div>
        </aside>

        <section className="audit-detail-pane">
          {detailLoading && !detail && <div className="audit-detail-empty"><h2>正在加载…</h2></div>}
          {!detail && !detailLoading && <div className="audit-detail-empty"><h2>选择一个会话</h2><p>查看工具调用时间线与事件流。</p></div>}
          {detail && (
            <>
              <div className="audit-detail-head">
                <h1>{detail.session.title}</h1>
                <small>
                  {detail.session.agent} · {detail.session.model.modelId}
                </small>
              </div>
              <section className="audit-detail-section">
                <div className="pane-heading">
                  <span>工具时间线</span>
                  <small>{detail.toolTimeline.length}</small>
                </div>
                <div className="audit-tool-timeline">
                  {detail.toolTimeline.map((node) => (
                    <article key={node.callId} className={`audit-tool-node ${node.status === "completed" ? "completed" : node.status === "error" ? "failed" : "running"}`}>
                      <div className="audit-tool-node-head">
                        <span className="audit-tool-name">{node.tool}</span>
                        <span className="audit-tool-args">{node.title ?? ""}</span>
                        <span className="audit-tool-state">{node.status}</span>
                      </div>
                      {node.output && (
                        <div className="audit-tool-body">
                          <pre>{node.output}</pre>
                        </div>
                      )}
                    </article>
                  ))}
                  {!detail.toolTimeline.length && <p className="empty-state">此会话没有工具调用。</p>}
                </div>
              </section>
              <section className="audit-detail-section">
                <div className="pane-heading">
                  <span>事件流</span>
                  <small>{detail.events.length}</small>
                </div>
                <div className="audit-tool-timeline">
                  {detail.events.map((event) => {
                    const open = openEvents.has(event.seq);
                    return (
                      <div key={event.seq} className={`audit-tool-node ${open ? "open" : ""}`}>
                        <button type="button" className="audit-event-toggle" onClick={() => toggleEvent(event.seq)} aria-expanded={open}>
                          <span className="audit-tool-name">#{event.seq}</span>
                          <span className="audit-tool-args">{event.type}</span>
                          <span className="audit-tool-state">{timeLabel(event.at)}</span>
                          <span className="audit-event-json-hint">{open ? "收起" : "JSON"}</span>
                        </button>
                        <div className="audit-event-json">
                          <pre>{JSON.stringify(event.data, null, 2)}</pre>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
