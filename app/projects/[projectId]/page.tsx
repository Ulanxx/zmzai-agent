"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, EmptyState, Icon, IconButton, Input, Navbar, Select as ThemeSelect, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@zmzai/theme";

type Project = { projectId: string; workspaceId: string; name: string; description: string; instructions: string; updatedAt: string };
type Task = { taskId: string; title: string; goal: string; status: "draft" | "active" | "succeeded" | "failed" | "cancelled"; updatedAt: string };
type Run = { runId: string; taskId: string; status: string; attempt: number; startedAt: string | null; finishedAt: string | null; terminalReason: string | null; createdAt: string };
type Artifact = { artifactId: string; title: string; path: string; version: number; qualityStatus: string; bytes: number; createdAt: string; taskId: string | null; taskTitle: string | null; downloadUrl: string | null; previewUrl: string | null };
type ContextItem = { contextId: string; type: "note" | "link"; title: string; content: string; url: string; enabled: boolean; createdAt: string };
type Member = { memberId: string; userId: string; role: "viewer" | "member" | "editor"; user: { name: string; email: string } | null };
type Automation = { automationId: string; projectId?: string | null; name: string; schedule: string; status: "active" | "paused"; lastRunStatus: "idle" | "running" | "succeeded" | "failed"; lastRunTaskId?: string | null; lastError?: string | null };
type Budget = { projectId: string; maxConcurrentRuns: number; monthlyTokenBudget: number; usedTokens: number; usagePeriod: string; reservedRuns: number };

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

function statusVariant(status: string) {
  if (status === "succeeded" || status === "delivered") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "active" || status === "running") return "accent" as const;
  return "outline" as const;
}
function statusText(status: string) {
  return ({ succeeded: "已完成", failed: "需要处理", active: "进行中", draft: "草稿", cancelled: "已取消", paused: "已暂停", created: "准备中", running: "执行中", waiting_input: "等待补充", waiting_approval: "等待审批", queued: "排队中", idle: "就绪" } as Record<string, string>)[status] ?? status;
}
const roleText = (role: string) => role === "owner" ? "所有者" : role === "editor" ? "编辑者" : role === "member" ? "成员" : "查看者";

function SectionHead({ eyebrow, title, right }: { eyebrow: string; title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <small className="block text-[10px] font-semibold uppercase tracking-wide text-ink-3">{eyebrow}</small>
        <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
      </div>
      {right}
    </div>
  );
}

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [role, setRole] = useState<"owner" | "viewer" | "member" | "editor">("owner");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextType, setContextType] = useState<ContextItem["type"]>("note");
  const [contextTitle, setContextTitle] = useState("");
  const [contextContent, setContextContent] = useState("");
  const [contextUrl, setContextUrl] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<Member["role"]>("member");
  const [memberBusy, setMemberBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [detail, artifactResult, memberResult, automationResult, budgetResult] = await Promise.all([
      json<{ project: Project; tasks: Task[]; runs: Run[]; contextItems: ContextItem[]; role: "owner" | "viewer" | "member" | "editor" }>(`/api/projects/${encodeURIComponent(projectId)}`),
      json<{ artifacts: Artifact[] }>(`/api/artifacts?projectId=${encodeURIComponent(projectId)}&limit=50`),
      json<{ members: Member[] }>(`/api/projects/${encodeURIComponent(projectId)}/members`),
      json<{ automations: Automation[] }>("/api/automations"),
      json<{ budget: Budget }>(`/api/projects/${encodeURIComponent(projectId)}/budget`),
    ]);
    setProject(detail.project);
    setTasks(detail.tasks);
    setRuns(detail.runs);
    setContextItems(detail.contextItems ?? []);
    setMembers(memberResult.members ?? []);
    setAutomations(automationResult.automations.filter((automation) => automation.projectId === projectId));
    setBudget(budgetResult.budget);
    setRole(detail.role);
    setArtifacts(artifactResult.artifacts);
    setName(detail.project.name);
    setDescription(detail.project.description);
    setInstructions(detail.project.instructions);
  };

  const saveBudget = async (patch: Pick<Budget, "maxConcurrentRuns" | "monthlyTokenBudget">) => {
    if (budgetBusy) return;
    setBudgetBusy(true);
    try {
      const result = await json<{ budget: Budget }>(`/api/projects/${encodeURIComponent(projectId)}/budget`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      setBudget(result.budget); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存预算设置失败"); }
    finally { setBudgetBusy(false); }
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      json<{ project: Project; tasks: Task[]; runs: Run[]; contextItems: ContextItem[]; role: "owner" | "viewer" | "member" | "editor" }>(`/api/projects/${encodeURIComponent(projectId)}`),
      json<{ artifacts: Artifact[] }>(`/api/artifacts?projectId=${encodeURIComponent(projectId)}&limit=50`),
      json<{ members: Member[] }>(`/api/projects/${encodeURIComponent(projectId)}/members`),
      json<{ automations: Automation[] }>("/api/automations"),
      json<{ budget: Budget }>(`/api/projects/${encodeURIComponent(projectId)}/budget`),
    ]).then(([detail, artifactResult, memberResult, automationResult, budgetResult]) => {
      if (cancelled) return;
      setProject(detail.project); setTasks(detail.tasks); setRuns(detail.runs); setContextItems(detail.contextItems ?? []); setMembers(memberResult.members ?? []); setRole(detail.role); setArtifacts(artifactResult.artifacts); setAutomations(automationResult.automations.filter((automation) => automation.projectId === projectId));
      setName(detail.project.name); setDescription(detail.project.description); setInstructions(detail.project.instructions); setBudget(budgetResult.budget); setError(null);
    }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载项目"); });
    return () => { cancelled = true; };
  }, [projectId]);

  const counts = useMemo(() => ({ active: tasks.filter((task) => task.status === "active").length, done: tasks.filter((task) => task.status === "succeeded").length, failed: tasks.filter((task) => task.status === "failed").length }), [tasks]);
  const canEdit = role === "owner" || role === "editor";

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await json(`/api/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, instructions }) }); await load(); setEditing(false); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存项目失败"); }
    finally { setBusy(false); }
  };

  const addContext = async () => {
    if (!contextTitle.trim() || contextBusy || (contextType === "note" ? !contextContent.trim() : !contextUrl.trim())) return;
    setContextBusy(true);
    try {
      const result = await json<{ contextItem: ContextItem }>(`/api/projects/${encodeURIComponent(projectId)}/context`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: contextType, title: contextTitle, content: contextType === "note" ? contextContent : "", url: contextType === "link" ? contextUrl : "" }),
      });
      setContextItems((items) => [result.contextItem, ...items]);
      setContextTitle(""); setContextContent(""); setContextUrl(""); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "添加项目上下文失败"); }
    finally { setContextBusy(false); }
  };

  const updateContext = async (item: ContextItem, patch: Partial<Pick<ContextItem, "enabled">>) => {
    try {
      const result = await json<{ contextItem: ContextItem }>(`/api/projects/${encodeURIComponent(projectId)}/context/${encodeURIComponent(item.contextId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      setContextItems((items) => items.map((current) => current.contextId === item.contextId ? result.contextItem : current));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新项目上下文失败"); }
  };

  const removeContext = async (item: ContextItem) => {
    try {
      await json(`/api/projects/${encodeURIComponent(projectId)}/context/${encodeURIComponent(item.contextId)}`, { method: "DELETE" });
      setContextItems((items) => items.filter((current) => current.contextId !== item.contextId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除项目上下文失败"); }
  };

  const addMember = async () => {
    if (!memberEmail.trim() || memberBusy || role !== "owner") return;
    setMemberBusy(true);
    try {
      const result = await json<{ member: Member }>(`/api/projects/${encodeURIComponent(projectId)}/members`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: memberEmail, role: memberRole }) });
      setMembers((items) => [...items.filter((item) => item.memberId !== result.member.memberId), result.member]); setMemberEmail(""); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "添加项目成员失败"); }
    finally { setMemberBusy(false); }
  };

  const updateMember = async (member: Member, nextRole: Member["role"]) => {
    try {
      const result = await json<{ member: Member }>(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.memberId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: nextRole }) });
      setMembers((items) => items.map((item) => item.memberId === member.memberId ? { ...item, ...result.member } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新成员角色失败"); }
  };

  const removeMember = async (member: Member) => {
    try {
      await json(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.memberId)}`, { method: "DELETE" });
      setMembers((items) => items.filter((item) => item.memberId !== member.memberId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "移除项目成员失败"); }
  };

  if (!project && !error) return <main className="grid min-h-dvh place-items-center bg-bg"><p className="text-sm text-ink-3">正在打开项目…</p></main>;
  return <main className="min-h-dvh bg-bg">
    <Navbar sublabel="agent" badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">a.zmzai.cloud</span>}>
      <Link href="/projects" className="text-xs text-ink-3 transition-colors hover:text-ink"><Icon name="arrow-left" size={12} className="mr-1 inline" />返回项目</Link>
      <Link href="/fw" className="text-xs text-ink-3 transition-colors hover:text-ink">新对话</Link>
    </Navbar>
    <div className="mx-auto w-[min(100%-2rem,74rem)] py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <small className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-3">长期上下文</small>
          <h1 className="truncate text-2xl font-semibold tracking-tight text-ink">{project?.name ?? "项目"}</h1>
          <p className="mt-1 text-sm text-ink-3">{project?.description || "把持续目标、任务和成果放在同一个工作空间里。"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" size="sm">你的角色：{roleText(role)}</Badge>
          {canEdit && <Button type="button" variant="secondary" size="sm" onClick={() => setEditing((current) => !current)}><Icon name={editing ? "cross" : "edit"} size={13} />{editing ? "关闭编辑" : "编辑项目"}</Button>}
        </div>
      </header>
      {error && <div className="mb-4 rounded-sm border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-ink" role="status">{error}</div>}

      {project && <>
      <div className="mb-6 flex flex-wrap gap-2">
        <Badge variant="outline" size="md">{tasks.length} 任务</Badge>
        <Badge variant="accent" size="md">{counts.active} 进行中</Badge>
        <Badge variant="success" size="md">{counts.done} 已完成</Badge>
        {counts.failed > 0 && <Badge variant="danger" size="md">{counts.failed} 需要处理</Badge>}
        <Badge variant="outline" size="md">{artifacts.length} 成果</Badge>
      </div>

      {budget && (
        <Card padding="md" className="mb-6">
          <SectionHead eyebrow="资源边界" title="项目预算" right={<Badge variant="outline" size="sm">{budget.reservedRuns} / {budget.maxConcurrentRuns} 个运行中</Badge>} />
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-3">最大并发运行<Input type="number" min={1} max={32} value={budget.maxConcurrentRuns} disabled={!canEdit || budgetBusy} onChange={(event) => setBudget((current) => current ? { ...current, maxConcurrentRuns: Math.max(1, Math.min(32, Number(event.target.value) || 1)) } : current)} onBlur={() => { if (budget) void saveBudget({ maxConcurrentRuns: budget.maxConcurrentRuns, monthlyTokenBudget: budget.monthlyTokenBudget }); }} className="mt-1 w-36" /></label>
            <label className="text-xs text-ink-3">月度 Token 上限<Input type="number" min={0} max={10000000000} value={budget.monthlyTokenBudget} disabled={!canEdit || budgetBusy} onChange={(event) => setBudget((current) => current ? { ...current, monthlyTokenBudget: Math.max(0, Number(event.target.value) || 0) } : current)} onBlur={() => { if (budget) void saveBudget({ maxConcurrentRuns: budget.maxConcurrentRuns, monthlyTokenBudget: budget.monthlyTokenBudget }); }} className="mt-1 w-44" /></label>
            <div className="rounded-sm border border-line bg-surface px-3 py-2"><small className="block text-xs text-ink-3">本月已用</small><strong className="font-mono text-sm text-ink">{budget.usedTokens.toLocaleString("zh-CN")}</strong><small className="ml-2 text-ink-3">{budget.monthlyTokenBudget > 0 ? `上限 ${budget.monthlyTokenBudget.toLocaleString("zh-CN")}` : "未设置 Token 上限"}</small></div>
          </div>
        </Card>
      )}

      {canEdit && editing && (
        <Card padding="md" className="mb-6">
          <SectionHead eyebrow="编辑" title="项目设置" />
          <div className="flex flex-col gap-3">
            <label className="text-xs text-ink-3">项目名称<Input value={name} onChange={(event) => setName(event.target.value)} className="mt-1" /></label>
            <label className="text-xs text-ink-3">项目描述<Input value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1" /></label>
            <label className="text-xs text-ink-3">执行指令<Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} placeholder="告诉 Agent 在这个项目里应该遵循的长期规则" className="mt-1" /></label>
            <div><Button type="button" onClick={() => void save()} disabled={busy || !name.trim()}><Icon name="check" size={13} />{busy ? "保存中" : "保存更改"}</Button></div>
          </div>
        </Card>
      )}

      <Card padding="md" className="mb-6">
        <SectionHead eyebrow="长期资料" title="项目上下文" right={<Badge variant="outline" size="sm">{contextItems.filter((item) => item.enabled).length} 项启用</Badge>} />
        <p className="mb-3 text-sm text-ink-3">把品牌规范、业务背景或参考链接放在这里。启用的资料会随项目任务提供给 Agent。</p>
        {canEdit && (
          <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-line pb-4">
            <ThemeSelect value={contextType} onValueChange={(value: string) => setContextType(value === "link" ? "link" : "note")}>
              <SelectTrigger className="w-auto" aria-label="上下文类型"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="note">笔记</SelectItem><SelectItem value="link">链接</SelectItem></SelectContent>
            </ThemeSelect>
            <Input aria-label="上下文标题" value={contextTitle} onChange={(event) => setContextTitle(event.target.value)} placeholder="标题" className="min-w-0 flex-1" />
            {contextType === "note"
              ? <Textarea aria-label="上下文内容" value={contextContent} onChange={(event) => setContextContent(event.target.value)} rows={2} placeholder="记录 Agent 需要长期知道的事实" className="min-w-0 flex-1" />
              : <Input aria-label="上下文链接" value={contextUrl} onChange={(event) => setContextUrl(event.target.value)} placeholder="https://..." inputMode="url" className="min-w-0 flex-1" />}
            <Button type="button" size="sm" onClick={() => void addContext()} disabled={contextBusy || !contextTitle.trim() || (contextType === "note" ? !contextContent.trim() : !contextUrl.trim())}><Icon name="plus" size={13} />{contextBusy ? "添加中" : "添加资料"}</Button>
          </div>
        )}
        {contextItems.length ? <div className="flex flex-col gap-2">
          {contextItems.map((item) => (
            <div className={`flex items-center gap-2 rounded-sm border border-line px-3 py-2 ${item.enabled ? "bg-bg" : "bg-surface opacity-60"}`} key={item.contextId}>
              <span className="grid size-7 place-items-center rounded-sm border border-line bg-surface text-ink-2"><Icon name={item.type === "note" ? "file-text" : "link"} size={14} /></span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-sm text-ink">{item.title}</strong>
                {item.type === "note" ? <small className="block truncate text-xs text-ink-3">{item.content}</small> : <a href={item.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-ink-3 underline">{item.url}</a>}
              </div>
              {canEdit && <>
                <Button type="button" variant="secondary" size="sm" onClick={() => void updateContext(item, { enabled: !item.enabled })}><Icon name={item.enabled ? "eye" : "eye-off"} size={13} />{item.enabled ? "停用" : "启用"}</Button>
                <IconButton size="sm" label={`删除 ${item.title}`} onClick={() => void removeContext(item)}><Icon name="trash" size={13} /></IconButton>
              </>}
            </div>
          ))}
        </div> : <EmptyState title="还没有项目资料" description="把长期有效的背景信息添加到这里。" />}
      </Card>

      <Card padding="md" className="mb-6">
        <SectionHead eyebrow="协作" title="项目成员" right={<Badge variant="outline" size="sm">你的角色：{roleText(role)}</Badge>} />
        {role === "owner" && (
          <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-line pb-4">
            <Input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="成员邮箱" aria-label="成员邮箱" className="min-w-0 flex-1" />
            <ThemeSelect value={memberRole} onValueChange={(value: string) => setMemberRole(value as Member["role"])}>
              <SelectTrigger className="w-auto" aria-label="成员角色"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="viewer">查看者</SelectItem><SelectItem value="member">成员</SelectItem><SelectItem value="editor">编辑者</SelectItem></SelectContent>
            </ThemeSelect>
            <Button type="button" size="sm" onClick={() => void addMember()} disabled={memberBusy || !memberEmail.trim()}><Icon name="plus" size={13} />{memberBusy ? "添加中" : "添加成员"}</Button>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-sm border border-line bg-surface px-3 py-2">
            <span className="grid size-7 place-items-center rounded-sm border border-line bg-bg text-ink-2"><Icon name="user" size={13} /></span>
            <div className="min-w-0 flex-1"><strong className="block text-sm text-ink">项目所有者</strong><small className="text-xs text-ink-3">Owner</small></div>
            <Badge variant="accent" size="sm">所有者</Badge>
          </div>
          {members.map((member) => (
            <div className="flex items-center gap-2 rounded-sm border border-line px-3 py-2" key={member.memberId}>
              <span className="grid size-7 place-items-center rounded-sm border border-line bg-surface text-ink-2"><Icon name="user" size={13} /></span>
              <div className="min-w-0 flex-1"><strong className="block truncate text-sm text-ink">{member.user?.name || member.user?.email || member.userId}</strong><small className="text-xs text-ink-3">{member.user?.email || "成员"}</small></div>
              {role === "owner" ? <>
                <ThemeSelect value={member.role} onValueChange={(value: string) => void updateMember(member, value as Member["role"])} >
                  <SelectTrigger className="w-auto" aria-label={`${member.user?.email || member.userId} 的角色`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="viewer">查看者</SelectItem><SelectItem value="member">成员</SelectItem><SelectItem value="editor">编辑者</SelectItem></SelectContent>
                </ThemeSelect>
                <IconButton size="sm" label={`移除 ${member.user?.email || member.userId}`} onClick={() => void removeMember(member)}><Icon name="trash" size={13} /></IconButton>
              </> : <Badge variant="outline" size="sm">{roleText(member.role)}</Badge>}
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card padding="md">
          <SectionHead eyebrow="任务" title="项目任务" right={<Link href="/fw" className="text-xs text-ink-3 underline hover:text-ink">开始新任务 <Icon name="arrow-up-right" size={12} className="inline" /></Link>} />
          {tasks.length ? <div className="flex flex-col gap-1">
            {tasks.map((task) => (
              <Link href={`/fw/t/${task.taskId}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface" key={task.taskId}>
                <Badge variant={statusVariant(task.status)} size="sm">{statusText(task.status)}</Badge>
                <span className="min-w-0 flex-1"><strong className="block truncate text-sm text-ink">{task.title || "未命名任务"}</strong><small className="block truncate text-xs text-ink-3">{task.goal}</small></span>
                <small className="flex-shrink-0 text-xs text-ink-3">{formatDate(task.updatedAt)}</small>
              </Link>
            ))}
          </div> : <EmptyState title="还没有任务" description="从对话开始第一个任务。" />}
        </Card>
        <Card padding="md">
          <SectionHead eyebrow="交付" title="项目成果" right={<Link href="/artifacts" className="text-xs text-ink-3 underline hover:text-ink">查看全部 <Icon name="arrow-up-right" size={12} className="inline" /></Link>} />
          {artifacts.length ? <div className="flex flex-col gap-1">
            {artifacts.slice(0, 8).map((artifact) => (
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface" key={artifact.artifactId}>
                <Icon name="file" size={14} className="flex-shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1"><strong className="block truncate text-sm text-ink">{artifact.title}</strong><small className="block truncate text-xs text-ink-3">{artifact.taskTitle || artifact.path} · v{artifact.version} · {formatBytes(artifact.bytes)}</small></span>
                {artifact.previewUrl && <a href={artifact.previewUrl} target="_blank" rel="noreferrer" title="预览" aria-label={`预览 ${artifact.title}`} className="text-ink-3 hover:text-ink"><Icon name="eye" size={13} /></a>}
                {artifact.downloadUrl && <a href={artifact.downloadUrl} title="下载" aria-label={`下载 ${artifact.title}`} className="text-ink-3 hover:text-ink"><Icon name="download" size={13} /></a>}
              </div>
            ))}
          </div> : <EmptyState title="还没有成果" description="完成任务后，交付文件会出现在这里。" />}
        </Card>
      </div>

      <Card padding="md" className="mb-6">
        <SectionHead eyebrow="重复工作" title="项目自动化" right={<Link href="/automations" className="text-xs text-ink-3 underline hover:text-ink">管理自动化 <Icon name="arrow-up-right" size={12} className="inline" /></Link>} />
        {automations.length ? <div className="flex flex-col gap-1">
          {automations.map((automation) => (
            <Link href="/automations" className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface" key={automation.automationId}>
              <Badge variant={statusVariant(automation.lastRunStatus === "failed" ? "failed" : automation.status === "paused" ? "cancelled" : "active")} size="sm">{automation.lastRunStatus === "failed" ? "需要重试" : automation.status === "paused" ? "已暂停" : "已启用"}</Badge>
              <span className="min-w-0 flex-1"><strong className="block truncate text-sm text-ink">{automation.name}</strong><small className="block truncate text-xs text-ink-3">{automation.schedule}{automation.lastRunTaskId ? ` · 最近任务 ${automation.lastRunTaskId}` : ""}{automation.lastError ? ` · ${automation.lastError}` : ""}</small></span>
            </Link>
          ))}
        </div> : <EmptyState title="还没有项目自动化" description="成功任务可保存为该项目的自动化模板。" />}
      </Card>

      <Card padding="md">
        <SectionHead eyebrow="运行记录" title="最近运行" right={<Badge variant="outline" size="sm">{runs.length} 次运行</Badge>} />
        {runs.length ? <div className="flex flex-col gap-1">
          {runs.slice(0, 12).map((run) => (
            <Link href={`/fw/t/${run.taskId}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface" key={run.runId}>
              <Badge variant={statusVariant(run.status)} size="sm">{statusText(run.status)}</Badge>
              <span className="min-w-0 flex-1"><strong className="block truncate text-sm text-ink">{tasks.find((task) => task.taskId === run.taskId)?.title || "任务运行"}</strong><small className="text-xs text-ink-3">第 {run.attempt} 次尝试 · {formatDate(run.createdAt)}</small></span>
            </Link>
          ))}
        </div> : <EmptyState title="还没有运行记录" description="项目任务运行后会出现在这里。" />}
      </Card>
      </>}
    </div>
  </main>;
}
