"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { Badge, Button, Card, EmptyState, Icon } from "@zmzai/theme";

import { WorkbenchRail } from "@/framework/client/workbench-rail";

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

function statusVariant(status: "queued" | "running" | "succeeded" | "failed") {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "running") return "accent" as const;
  return "outline" as const;
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ResearchWorkbench({ researchJobId }: { researchJobId: string | null }) {
  const [items, setItems] = useState<ResearchSummary[]>([]);
  const [detail, setDetail] = useState<ResearchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 48rem)");
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

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

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-bg md:flex-row">
      <WorkbenchRail tasks={[]} activeTaskId={null} onNew={() => { window.location.href = "/fw"; }} onOpen={() => undefined} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="fw-grid">
        <div className="fw-main">
        <PanelGroup
          key={isNarrow ? "research-split-vertical" : "research-split-horizontal"}
          direction={isNarrow ? "vertical" : "horizontal"}
          autoSaveId={isNarrow ? "research-list-detail-split-v" : "research-list-detail-split"}
        >
          <Panel defaultSize={38} minSize={24} className="fw-panel">
            <section className="fw-conversation">
              <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
                <div className="min-w-0">
                  <small className="block text-xs font-semibold uppercase tracking-wide text-ink-3">多视角执行</small>
                  <h1 className="text-lg font-semibold tracking-tight">广泛研究</h1>
                </div>
                <Badge variant="outline" size="sm">{items.length} 项</Badge>
              </div>
              <div className="conversation-scroll">
                {error && <div className="mb-3 rounded-sm border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-ink" role="alert">{error}</div>}
                {loading && !items.length ? (
                  <p className="text-sm text-ink-3">正在加载…</p>
                ) : items.length ? (
                  <div className="flex flex-col gap-2">
                    {items.map((item) => (
                      <Card key={item.researchJobId} padding="sm" variant={item.researchJobId === researchJobId ? "interactive" : "default"} className={item.researchJobId === researchJobId ? "border-ink" : undefined}>
                        <Link href={`/fw/research/${item.researchJobId}`} className="block">
                          <div className="flex items-start justify-between gap-2">
                            <strong className="min-w-0 text-sm font-medium text-ink">{item.question}</strong>
                            <Badge variant={statusVariant(item.status)} size="sm">{statusLabel(item.status)}</Badge>
                          </div>
                          <small className="mt-1 block text-xs text-ink-3">{item.completedChildren}/{item.childCount} 个角色完成 · {dateLabel(item.updatedAt)}</small>
                        </Link>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={<Icon name="search" size={24} />} title="还没有研究" description="从一条需要比较、核验或综合的问题开始。" action={<Link href="/fw"><Button variant="secondary" size="sm"><Icon name="plus" size={13} />开始研究</Button></Link>} />
                )}
              </div>
            </section>
          </Panel>
          <PanelResizeHandle className="fw-resizer" />
          <Panel defaultSize={62} minSize={24} className="fw-panel">
            <aside className="fw-canvas">
              {detail ? (
                <div className="fw-canvas-body">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <small className="block text-xs font-semibold uppercase tracking-wide text-ink-3">研究详情</small>
                      <h2 className="truncate text-base font-semibold text-ink">{detail.question}</h2>
                      <small className="text-xs text-ink-3">{dateLabel(detail.createdAt)} · 并行度 {detail.maxConcurrency}</small>
                    </div>
                    <Link href={`/fw/t/${detail.taskId}`}><Button variant="secondary" size="sm"><Icon name="arrow-up-right" size={14} />打开任务</Button></Link>
                  </div>
                  <div className="grid grid-cols-3 gap-2 rounded-sm border border-line bg-surface p-3">
                    <div><small className="block text-xs text-ink-3">整体状态</small><Badge variant={statusVariant(detail.status)} size="sm" className="mt-1">{statusLabel(detail.status)}</Badge></div>
                    <div><small className="block text-xs text-ink-3">研究角色</small><Badge variant="outline" size="sm" className="mt-1">{detail.completedChildren}/{detail.childCount} 完成</Badge></div>
                    <div><small className="block text-xs text-ink-3">综合结果</small><Badge variant={statusVariant(detail.synthesisStatus)} size="sm" className="mt-1">{statusLabel(detail.synthesisStatus)}</Badge></div>
                  </div>
                  {detail.error && (
                    <div className="flex items-center gap-2 rounded-sm border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-ink" role="alert">
                      <Icon name="warning" size={14} /><span className="min-w-0 flex-1">{detail.error}</span>
                      <Button type="button" variant="secondary" size="sm" onClick={() => { window.location.href = `/fw/t/${detail.taskId}`; }}><Icon name="refresh" size={13} />去任务处理</Button>
                    </div>
                  )}
                  <div>
                    <div className="flex items-center justify-between">
                      <strong className="text-sm font-semibold text-ink">研究角色</strong>
                      <span className="text-xs text-ink-3">最多 {detail.maxConcurrency} 个并行</span>
                    </div>
                    <div className="mt-2 flex flex-col gap-2">
                      {detail.children.map((child) => (
                        <Card key={child.runId} padding="sm">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <strong className="block text-sm text-ink">{child.role}</strong>
                              <small className="text-xs text-ink-3">{statusLabel(child.status)}{child.finishedAt ? ` · ${dateLabel(child.finishedAt)}` : ""}</small>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant={statusVariant(child.status)} size="sm">{statusLabel(child.status)}</Badge>
                              <Link href={`/fw/t/${child.taskId}`} title="打开子任务" className="text-ink-3 hover:text-ink"><Icon name="arrow-up-right" size={14} /></Link>
                            </div>
                          </div>
                          {child.summary && <p className="mt-1 text-sm text-ink-2">{child.summary}</p>}
                          {child.error && <p className="mt-1 text-sm text-danger">{child.error}</p>}
                        </Card>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <EmptyState icon={<Icon name="search" size={28} />} title="选择一项研究" description="在左侧查看研究进度、角色结果和失败信息。" />
              )}
            </aside>
          </Panel>
        </PanelGroup>
        </div>
      </div>
      </div>
    </main>
  );
}
