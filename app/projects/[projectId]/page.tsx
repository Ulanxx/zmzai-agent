"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button, Icon } from "@zmzai/theme";

type Project = { projectId: string; workspaceId: string; name: string; description: string; instructions: string; updatedAt: string };
type Task = { taskId: string; title: string; goal: string; status: "draft" | "active" | "succeeded" | "failed" | "cancelled"; updatedAt: string };
type Run = { runId: string; taskId: string; status: string; attempt: number; startedAt: string | null; finishedAt: string | null; terminalReason: string | null; createdAt: string };
type Artifact = { artifactId: string; title: string; path: string; version: number; qualityStatus: string; bytes: number; createdAt: string; taskId: string | null; taskTitle: string | null; downloadUrl: string | null; previewUrl: string | null };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && body !== null && "error" in body ? String(body.error) : "请求失败");
  return body as T;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "--";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [detail, artifactResult] = await Promise.all([
      json<{ project: Project; tasks: Task[]; runs: Run[] }>(`/api/projects/${encodeURIComponent(projectId)}`),
      json<{ artifacts: Artifact[] }>(`/api/artifacts?projectId=${encodeURIComponent(projectId)}&limit=50`),
    ]);
    setProject(detail.project);
    setTasks(detail.tasks);
    setRuns(detail.runs);
    setArtifacts(artifactResult.artifacts);
    setName(detail.project.name);
    setDescription(detail.project.description);
    setInstructions(detail.project.instructions);
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      json<{ project: Project; tasks: Task[]; runs: Run[] }>(`/api/projects/${encodeURIComponent(projectId)}`),
      json<{ artifacts: Artifact[] }>(`/api/artifacts?projectId=${encodeURIComponent(projectId)}&limit=50`),
    ]).then(([detail, artifactResult]) => {
      if (cancelled) return;
      setProject(detail.project); setTasks(detail.tasks); setRuns(detail.runs); setArtifacts(artifactResult.artifacts);
      setName(detail.project.name); setDescription(detail.project.description); setInstructions(detail.project.instructions); setError(null);
    }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载项目"); });
    return () => { cancelled = true; };
  }, [projectId]);

  const counts = useMemo(() => ({ active: tasks.filter((task) => task.status === "active").length, done: tasks.filter((task) => task.status === "succeeded").length, failed: tasks.filter((task) => task.status === "failed").length }), [tasks]);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await json(`/api/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, instructions }) }); await load(); setEditing(false); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存项目失败"); }
    finally { setBusy(false); }
  };

  if (!project && !error) return <main className="product-page"><div className="product-loading">正在打开项目…</div></main>;
  return <main className="product-page project-detail-page">
    <header className="product-page-head"><div><Link href="/projects" className="product-back"><Icon name="arrow-left" size={14} />返回项目</Link><span className="eyebrow">长期上下文</span><h1>{project?.name ?? "项目"}</h1><p>{project?.description || "把持续目标、任务和成果放在同一个工作空间里。"}</p></div><Link href="/fw" className="product-action-link">新对话 <Icon name="arrow-up-right" size={14} /></Link></header>
    {error && <div className="product-error" role="status">{error}</div>}
    {project && <>
      <section className="project-overview"><div><span className="eyebrow">项目概览</span><div className="project-stat-row"><span><strong>{tasks.length}</strong>任务</span><span><strong>{counts.active}</strong>进行中</span><span><strong>{counts.done}</strong>已完成</span><span><strong>{artifacts.length}</strong>成果</span></div></div><Button type="button" variant="secondary" size="sm" onClick={() => setEditing((current) => !current)}><Icon name={editing ? "cross" : "edit"} size={13} />{editing ? "关闭编辑" : "编辑项目"}</Button></section>
      {editing && <section className="project-editor"><label>项目名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>项目描述<input value={description} onChange={(event) => setDescription(event.target.value)} /></label><label>执行指令<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} placeholder="告诉 Agent 在这个项目里应该遵循的长期规则" /></label><div><Button type="button" onClick={() => void save()} disabled={busy || !name.trim()}><Icon name="check" size={13} />{busy ? "保存中" : "保存更改"}</Button></div></section>}
      <div className="project-detail-grid"><section className="project-detail-section"><div className="section-heading"><div><span className="eyebrow">任务</span><h2>项目任务</h2></div><Link href="/fw" className="text-link">开始新任务 <Icon name="arrow-up-right" size={13} /></Link></div>{tasks.length ? <div className="project-task-list">{tasks.map((task) => <Link href={`/fw/t/${task.taskId}`} className="project-task-row" key={task.taskId}><span className="project-task-status" data-status={task.status} /><span className="project-task-copy"><strong>{task.title || "未命名任务"}</strong><small>{task.goal}</small></span><span className="project-task-date">{formatDate(task.updatedAt)}</span><Icon name="arrow-right" size={13} /></Link>)}</div> : <div className="project-section-empty">还没有任务。<Link href="/fw">从对话开始</Link></div>}</section>
        <section className="project-detail-section"><div className="section-heading"><div><span className="eyebrow">交付</span><h2>项目成果</h2></div><Link href="/artifacts" className="text-link">查看全部 <Icon name="arrow-up-right" size={13} /></Link></div>{artifacts.length ? <div className="project-artifact-list">{artifacts.slice(0, 8).map((artifact) => <div className="project-artifact-row" key={artifact.artifactId}><Icon name="file" size={14} /><span><strong>{artifact.title}</strong><small>{artifact.taskTitle || artifact.path} · v{artifact.version} · {formatBytes(artifact.bytes)}</small></span>{artifact.previewUrl && <a href={artifact.previewUrl} target="_blank" rel="noreferrer" title="预览" aria-label={`预览 ${artifact.title}`}><Icon name="eye" size={13} /></a>}{artifact.downloadUrl && <a href={artifact.downloadUrl} title="下载" aria-label={`下载 ${artifact.title}`}><Icon name="download" size={13} /></a>}</div>)}</div> : <div className="project-section-empty">完成任务后，交付文件会出现在这里。</div>}</section></div>
      <section className="project-detail-section project-runs-section"><div className="section-heading"><div><span className="eyebrow">运行记录</span><h2>最近运行</h2></div><span className="section-caption">{runs.length} 次运行</span></div>{runs.length ? <div className="project-run-list">{runs.slice(0, 12).map((run) => <Link href={`/fw/t/${run.taskId}`} className="project-run-row" key={run.runId}><span className="project-task-status" data-status={run.status} /><span><strong>{tasks.find((task) => task.taskId === run.taskId)?.title || "任务运行"}</strong><small>第 {run.attempt} 次尝试 · {formatDate(run.createdAt)}</small></span><em data-status={run.status}>{run.status}</em><Icon name="arrow-right" size={13} /></Link>)}</div> : <div className="project-section-empty">项目还没有运行记录。</div>}</section>
    </>}
  </main>;
}
