"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, Icon, IconButton } from "@zmzai/theme";

type ResearchSummary = {
  researchJobId: string;
  taskId: string;
  workspaceId: string;
  projectId?: string | null;
  question: string;
  status: "queued" | "running" | "succeeded" | "failed";
  synthesisStatus: "queued" | "running" | "succeeded" | "failed";
  childCount: number;
  completedChildren: number;
  failedChildren: number;
  createdAt: string;
  updatedAt: string;
};

type ResearchDetail = ResearchSummary & {
  runId: string;
  sessionId: string;
  roles: string[];
  maxConcurrency: number;
  error?: string | null;
  children: Array<{
    taskId: string;
    runId: string;
    role: string;
    status: "queued" | "running" | "succeeded" | "failed";
    summary?: string | null;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }>;
};

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && body !== null && "error" in body ? String(body.error) : "无法加载研究记录");
  return body as T;
}

function statusLabel(status: ResearchDetail["status"] | ResearchDetail["synthesisStatus"] | ResearchDetail["children"][number]["status"]): string {
  return { queued: "排队中", running: "执行中", succeeded: "已完成", failed: "需要处理" }[status];
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ResearchWorkbench({ researchJobId }: { researchJobId: string | null }) {
  const [items, setItems] = useState<ResearchSummary[]>([]);
  const [detail, setDetail] = useState<ResearchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void json<{ researches: ResearchSummary[] }>("/api/research")
      .then((result) => { if (!cancelled) setItems(result.researches); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载研究记录"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!researchJobId) { setDetail(null); return; }
    let cancelled = false;
    const load = () => void json<{ research: ResearchDetail }>(`/api/research?researchJobId=${encodeURIComponent(researchJobId)}`)
      .then((result) => { if (!cancelled) setDetail(result.research); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载研究详情"); });
    load();
    const timer = window.setInterval(load, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [researchJobId]);

  return <main className="research-shell">
    <aside className="research-rail">
      <div className="task-rail-head"><Link href="/fw" className="task-brand"><span className="task-brand-mark">z</span><span>zmzai</span></Link><IconButton size="md" label="新对话" onClick={() => { window.location.href = "/fw"; }}><Icon name="plus" size={15} /></IconButton></div>
      <div className="task-rail-section">
        <span className="task-rail-label">工作</span>
        <Link href="/fw" className="task-rail-link"><Icon name="message" size={14} />新对话</Link>
        <Link href="/fw" className="task-rail-link"><Icon name="list" size={14} />任务</Link>
        <Link href="/fw/research" className="task-rail-link active"><Icon name="search" size={14} />广泛研究</Link>
        <Link href="/projects" className="task-rail-link"><Icon name="folder" size={14} />项目</Link>
        <Link href="/artifacts" className="task-rail-link"><Icon name="archive" size={14} />成果</Link>
      </div>
      <div className="task-rail-foot"><Link href="/audit"><Icon name="activity" size={13} />运行记录</Link></div>
    </aside>
    <section className="research-main">
      <header className="research-header"><div><span className="eyebrow">多视角执行</span><h1>广泛研究</h1><p>每项研究都会保留问题、研究角色、过程状态和最终综合结果。</p></div><Link href="/fw" className="product-action-link"><Icon name="plus" size={14} />新研究</Link></header>
      {error && <div className="product-error" role="alert">{error}</div>}
      <div className="research-layout">
        <section className="research-list" aria-label="研究历史">
          <div className="research-list-head"><strong>研究历史</strong><span>{items.length}</span></div>
          {loading && !items.length ? <div className="product-empty">正在加载…</div> : items.length ? items.map((item) => <Link href={`/fw/research/${item.researchJobId}`} className={`research-list-item ${item.researchJobId === researchJobId ? "selected" : ""}`} key={item.researchJobId}><span className={`research-status-dot ${item.status}`} /><span className="research-list-copy"><strong>{item.question}</strong><small>{statusLabel(item.status)} · {item.completedChildren}/{item.childCount} 个角色完成 · {dateLabel(item.updatedAt)}</small></span><Icon name="chevron-right" size={14} /></Link>) : <div className="product-empty"><Icon name="search" size={22} /><strong>还没有研究</strong><p>从一条需要比较、核验或综合的问题开始。</p><Link href="/fw" className="product-action-link">开始研究</Link></div>}
        </section>
        <section className="research-detail">
          {detail ? <>
            <div className="research-detail-head"><div><span className="eyebrow">研究详情</span><h2>{detail.question}</h2><small>{dateLabel(detail.createdAt)} · 并行度 {detail.maxConcurrency}</small></div><Link href={`/fw/t/${detail.taskId}`} className="product-action-link"><Icon name="arrow-up-right" size={14} />打开任务</Link></div>
            <div className="research-summary-strip"><div><span>整体状态</span><strong>{statusLabel(detail.status)}</strong></div><div><span>研究角色</span><strong>{detail.completedChildren}/{detail.childCount} 完成</strong></div><div><span>综合结果</span><strong>{statusLabel(detail.synthesisStatus)}</strong></div></div>
            {detail.error && <div className="research-error"><Icon name="warning" size={14} /><span>{detail.error}</span><Button type="button" variant="secondary" size="sm" onClick={() => { window.location.href = `/fw/t/${detail.taskId}`; }}><Icon name="refresh" size={13} />去任务处理</Button></div>}
            <div className="research-children"><div className="research-section-title"><strong>研究角色</strong><span>最多 {detail.maxConcurrency} 个并行</span></div>{detail.children.map((child) => <article className="research-child" key={child.runId}><div className="research-child-top"><span className={`research-status-dot ${child.status}`} /><div><strong>{child.role}</strong><small>{statusLabel(child.status)}{child.finishedAt ? ` · ${dateLabel(child.finishedAt)}` : ""}</small></div><Link href={`/fw/t/${child.taskId}`} title="打开子任务"><Icon name="arrow-up-right" size={14} /></Link></div>{child.summary && <p>{child.summary}</p>}{child.error && <p className="research-child-error">{child.error}</p>}</article>)}</div>
          </> : <div className="research-detail-empty"><Icon name="search" size={28} /><h2>选择一项研究</h2><p>在左侧查看研究进度、角色结果和失败信息。</p></div>}
        </section>
      </div>
    </section>
  </main>;
}
