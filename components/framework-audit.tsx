"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Seal } from "@/components/seal";

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
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    queueMicrotask(() => setDetail(null));
    void (async () => {
      try {
        const response = await fetch(`/api/audit/sessions/${encodeURIComponent(selected)}`, { cache: "no-store" });
        const body = (await response.json()) as AuditDetail & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "无法读取会话详情");
        setDetail(body);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法读取会话详情");
      }
    })();
  }, [selected]);

  if (loading) return <main className="workbench-loading">正在读取审计…</main>;

  return (
    <main className="audit-page">
      <header className="audit-header">
        <div className="audit-brand">
          <Seal size={24} className="agent-seal" />
          <span className="font-mono text-sm font-bold tracking-[0.08em]">ZMZAI AGENT</span>
        </div>
        <nav className="audit-header-nav">
          <Link href="/fw" className="audit-nav-link">
            工作台
          </Link>
          <Link href="/audit" className="audit-nav-link active">
            运行审计
          </Link>
        </nav>
      </header>
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
          {!detail && <div className="audit-detail-empty"><h2>选择一个会话</h2><p>查看工具调用时间线与事件流。</p></div>}
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
                  {detail.events.map((event) => (
                    <div key={event.seq} className="audit-tool-node">
                      <div className="audit-tool-node-head">
                        <span className="audit-tool-name">#{event.seq}</span>
                        <span className="audit-tool-args">{event.type}</span>
                        <span className="audit-tool-state">{timeLabel(event.at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
