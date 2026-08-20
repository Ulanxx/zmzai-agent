"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, Icon } from "@zmzai/theme";

type Workspace = { id: string; name: string };
type Project = { projectId: string; workspaceId: string; name: string; description: string; instructions: string; updatedAt: string };
type Task = { taskId: string; title: string; status: string; updatedAt: string };
type ProjectItem = { project: Project; tasks: Task[] };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && body !== null && "error" in body ? String(body.error) : "请求失败");
  return body as T;
}

export default function ProjectsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = () => Promise.all([json<{ workspaces: Workspace[] }>("/api/workspaces"), json<{ projects: ProjectItem[] }>("/api/projects")]);
  const applyPage = ([workspaceResult, projectResult]: [{ workspaces: Workspace[] }, { projects: ProjectItem[] }]) => {
      setWorkspaces(workspaceResult.workspaces);
      setWorkspaceId((current) => current || workspaceResult.workspaces[0]?.id || "");
      setItems(projectResult.projects);
      setError(null);
  };
  const load = async () => {
    try { applyPage(await fetchPage()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法加载项目"); }
  };

  useEffect(() => {
    let cancelled = false;
    void fetchPage().then((result) => { if (!cancelled) applyPage(result); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载项目"); });
    return () => { cancelled = true; };
  }, []);

  const create = async () => {
    if (!name.trim() || !workspaceId || creating) return;
    setCreating(true);
    try {
      await json("/api/projects", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ workspaceId, name, description }) });
      setName(""); setDescription(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建项目失败"); }
    finally { setCreating(false); }
  };

  return <main className="product-page">
    <header className="product-page-head"><div><Link href="/fw" className="product-back"><Icon name="arrow-left" size={14} />返回工作台</Link><span className="eyebrow">长期上下文</span><h1>项目</h1><p>把任务、资料和持续目标放在同一个工作空间里。</p></div><Link href="/fw" className="product-action-link">新对话 <Icon name="arrow-up-right" size={14} /></Link></header>
    {error && <div className="product-error" role="status">{error}</div>}
    <section className="project-create-line"><div><strong>创建项目</strong><span>为一组持续任务保存目标和指令。</span></div><div className="project-create-form"><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} aria-label="选择 Workspace">{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select><input value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话描述（可选）" /><Button type="button" onClick={() => void create()} disabled={!workspaceId || !name.trim() || creating}><Icon name="plus" size={14} />{creating ? "创建中" : "创建项目"}</Button></div></section>
    <section className="project-list">{items.length ? items.map(({ project, tasks }) => <article className="project-row" key={project.projectId}><Link href={`/projects/${project.projectId}`} className="project-row-open" aria-label={`打开项目 ${project.name}`}><div className="project-row-main"><div className="project-row-title"><span className="project-mark"><Icon name="folder" size={15} /></span><div><h2>{project.name}</h2><p>{project.description || "尚未添加项目描述"}</p></div></div><span className="project-workspace">{workspaces.find((workspace) => workspace.id === project.workspaceId)?.name ?? "Workspace"}</span></div></Link><div className="project-row-tasks">{tasks.length ? tasks.slice(0, 4).map((task) => <Link href={`/fw/t/${task.taskId}`} key={task.taskId}><span data-status={task.status} />{task.title || "未命名任务"}</Link>) : <span className="project-empty">还没有归属任务</span>}<Link href={`/projects/${project.projectId}`} className="project-open-icon" title="打开项目" aria-label={`打开项目 ${project.name}`}><Icon name="arrow-right" size={13} /></Link></div></article>) : <div className="product-empty"><Icon name="folder" size={22} /><strong>还没有项目</strong><p>创建一个项目，给长期任务保留上下文。</p></div>}</section>
  </main>;
}
