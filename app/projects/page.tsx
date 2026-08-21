"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Button, Card, EmptyState, Icon, Input, Select as ThemeSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@zmzai/theme";
import { LoginGate, useLoggedIn, WorkbenchRail } from "@/framework/client/workbench-rail";

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

const taskStatusVariant = (status: string): "success" | "danger" | "accent" | "outline" => (status === "succeeded" ? "success" : status === "failed" ? "danger" : status === "active" || status === "running" ? "accent" : "outline");
const taskStatusLabel = (status: string) => ({ succeeded: "已完成", failed: "需要处理", active: "进行中", draft: "草稿", cancelled: "已取消" }[status] ?? status);

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

  const { loggedIn, loading } = useLoggedIn();
  if (!loading && !loggedIn) return <LoginGate title="登录后查看项目" />;

  return <main className="flex min-h-dvh flex-col bg-bg md:flex-row">
    <WorkbenchRail tasks={[]} activeTaskId={null} onNew={() => { window.location.href = "/fw"; }} onOpen={() => undefined} />
    <div className="flex min-w-0 flex-1 flex-col">
    <div className="mx-auto flex w-[min(100%-2rem,74rem)] flex-1 flex-col py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <small className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-3">长期上下文</small>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">项目</h1>
          <p className="mt-1 text-sm text-ink-3">把任务、资料和持续目标放在同一个工作空间里。</p>
        </div>
        <Link href="/fw"><Button variant="secondary" size="sm">新对话 <Icon name="arrow-up-right" size={14} /></Button></Link>
      </header>
      {error && <div className="mb-4 rounded-sm border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-ink" role="status">{error}</div>}

      <Card padding="md" className="mb-6">
        <div className="mb-3"><strong className="text-sm font-semibold text-ink">创建项目</strong><span className="ml-2 text-xs text-ink-3">为一组持续任务保存目标和指令。</span></div>
        <div className="flex flex-wrap items-center gap-2">
          <ThemeSelect value={workspaceId || undefined} onValueChange={(value: string) => setWorkspaceId(value)}>
            <SelectTrigger className="w-auto" aria-label="选择 Workspace"><SelectValue placeholder="选择 Workspace" /></SelectTrigger>
            <SelectContent>
              {workspaces.map((workspace) => <SelectItem value={workspace.id} key={workspace.id}>{workspace.name}</SelectItem>)}
            </SelectContent>
          </ThemeSelect>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称" className="min-w-0 flex-1" />
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话描述（可选）" className="min-w-0 flex-1" />
          <Button type="button" onClick={() => void create()} disabled={!workspaceId || !name.trim() || creating}><Icon name="plus" size={14} />{creating ? "创建中" : "创建项目"}</Button>
        </div>
      </Card>

      <section className="flex flex-col gap-3">
        {items.length ? items.map(({ project, tasks }) => (
          <Card key={project.projectId} padding="md" variant="interactive">
            <Link href={`/projects/${project.projectId}`} aria-label={`打开项目 ${project.name}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid size-8 place-items-center rounded-sm border border-line bg-surface text-ink-2"><Icon name="folder" size={15} /></span>
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-ink">{project.name}</h2>
                    <p className="truncate text-sm text-ink-3">{project.description || "尚未添加项目描述"}</p>
                  </div>
                </div>
                <Badge variant="outline" size="sm">{workspaces.find((workspace) => workspace.id === project.workspaceId)?.name ?? "Workspace"}</Badge>
              </div>
            </Link>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {tasks.length ? tasks.slice(0, 4).map((task) => (
                <Link href={`/fw/t/${task.taskId}`} key={task.taskId} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-surface-2">
                  <Badge variant={taskStatusVariant(task.status)} size="sm">{taskStatusLabel(task.status)}</Badge>
                  <span className="max-w-[12rem] truncate">{task.title || "未命名任务"}</span>
                </Link>
              )) : <span className="text-xs text-ink-3">还没有归属任务</span>}
            </div>
          </Card>
        )) : <EmptyState icon={<Icon name="folder" size={24} />} title="还没有项目" description="创建一个项目，给长期任务保留上下文。" />}
      </section>
    </div>
    </div>
  </main>;
}
