"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button, Icon } from "@zmzai/theme";

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

  if (!project && !error) return <main className="product-page"><div className="product-loading">正在打开项目…</div></main>;
  return <main className="product-page project-detail-page">
    <header className="product-page-head"><div><Link href="/projects" className="product-back"><Icon name="arrow-left" size={14} />返回项目</Link><span className="eyebrow">长期上下文</span><h1>{project?.name ?? "项目"}</h1><p>{project?.description || "把持续目标、任务和成果放在同一个工作空间里。"}</p></div><Link href="/fw" className="product-action-link">新对话 <Icon name="arrow-up-right" size={14} /></Link></header>
    {error && <div className="product-error" role="status">{error}</div>}
      {project && <>
      <section className="project-overview"><div><span className="eyebrow">项目概览</span><div className="project-stat-row"><span><strong>{tasks.length}</strong>任务</span><span><strong>{counts.active}</strong>进行中</span><span><strong>{counts.done}</strong>已完成</span><span><strong>{artifacts.length}</strong>成果</span></div></div>{canEdit && <Button type="button" variant="secondary" size="sm" onClick={() => setEditing((current) => !current)}><Icon name={editing ? "cross" : "edit"} size={13} />{editing ? "关闭编辑" : "编辑项目"}</Button>}</section>
      {budget && <section className="project-budget-section"><div className="section-heading"><div><span className="eyebrow">资源边界</span><h2>项目预算</h2></div><span className="section-caption">{budget.reservedRuns} / {budget.maxConcurrentRuns} 个运行中</span></div><div className="project-budget-grid"><label>最大并发运行<input type="number" min={1} max={32} value={budget.maxConcurrentRuns} disabled={!canEdit || budgetBusy} onChange={(event) => setBudget((current) => current ? { ...current, maxConcurrentRuns: Math.max(1, Math.min(32, Number(event.target.value) || 1)) } : current)} onBlur={() => { if (budget) void saveBudget({ maxConcurrentRuns: budget.maxConcurrentRuns, monthlyTokenBudget: budget.monthlyTokenBudget }); }} /></label><label>月度 Token 上限<input type="number" min={0} max={10000000000} value={budget.monthlyTokenBudget} disabled={!canEdit || budgetBusy} onChange={(event) => setBudget((current) => current ? { ...current, monthlyTokenBudget: Math.max(0, Number(event.target.value) || 0) } : current)} onBlur={() => { if (budget) void saveBudget({ maxConcurrentRuns: budget.maxConcurrentRuns, monthlyTokenBudget: budget.monthlyTokenBudget }); }} /></label><div className="project-budget-usage"><span>本月已用</span><strong>{budget.usedTokens.toLocaleString("zh-CN")}</strong><small>{budget.monthlyTokenBudget > 0 ? `上限 ${budget.monthlyTokenBudget.toLocaleString("zh-CN")}` : "未设置 Token 上限"}</small></div></div></section>}
      {canEdit && editing && <section className="project-editor"><label>项目名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>项目描述<input value={description} onChange={(event) => setDescription(event.target.value)} /></label><label>执行指令<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} placeholder="告诉 Agent 在这个项目里应该遵循的长期规则" /></label><div><Button type="button" onClick={() => void save()} disabled={busy || !name.trim()}><Icon name="check" size={13} />{busy ? "保存中" : "保存更改"}</Button></div></section>}
      <section className="project-detail-section project-context-section"><div className="section-heading"><div><span className="eyebrow">长期资料</span><h2>项目上下文</h2></div><span className="section-caption">{contextItems.filter((item) => item.enabled).length} 项启用</span></div><p className="project-section-note">把品牌规范、业务背景或参考链接放在这里。启用的资料会随项目任务提供给 Agent。</p>{canEdit && <div className="project-context-form"><select aria-label="上下文类型" value={contextType} onChange={(event) => setContextType(event.target.value as ContextItem["type"])}><option value="note">笔记</option><option value="link">链接</option></select><input aria-label="上下文标题" value={contextTitle} onChange={(event) => setContextTitle(event.target.value)} placeholder="标题" />{contextType === "note" ? <textarea aria-label="上下文内容" value={contextContent} onChange={(event) => setContextContent(event.target.value)} rows={3} placeholder="记录 Agent 需要长期知道的事实" /> : <input aria-label="上下文链接" value={contextUrl} onChange={(event) => setContextUrl(event.target.value)} placeholder="https://..." inputMode="url" />}<Button type="button" size="sm" onClick={() => void addContext()} disabled={contextBusy || !contextTitle.trim() || (contextType === "note" ? !contextContent.trim() : !contextUrl.trim())}><Icon name="plus" size={13} />{contextBusy ? "添加中" : "添加资料"}</Button></div>}{contextItems.length ? <div className="project-context-list">{contextItems.map((item) => <div className={`project-context-row ${item.enabled ? "" : "disabled"}`} key={item.contextId}><span className="project-context-kind"><Icon name={item.type === "note" ? "file-text" : "link"} size={14} /></span><span className="project-context-copy"><strong>{item.title}</strong>{item.type === "note" ? <small>{item.content}</small> : <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a>}</span>{canEdit && <><Button type="button" variant="secondary" size="sm" onClick={() => void updateContext(item, { enabled: !item.enabled })}><Icon name={item.enabled ? "eye" : "eye-off"} size={13} />{item.enabled ? "停用" : "启用"}</Button><button className="project-context-delete" type="button" onClick={() => void removeContext(item)} aria-label={`删除 ${item.title}`} title="删除"><Icon name="trash" size={13} /></button></>}</div>)}</div> : <div className="project-section-empty">还没有项目资料。</div>}</section>
      <section className="project-detail-section project-members-section"><div className="section-heading"><div><span className="eyebrow">协作</span><h2>项目成员</h2></div><span className="section-caption">你的角色：{role === "owner" ? "所有者" : role === "editor" ? "编辑者" : role === "member" ? "成员" : "查看者"}</span></div>{role === "owner" && <div className="project-member-form"><input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="成员邮箱" aria-label="成员邮箱" /><select value={memberRole} onChange={(event) => setMemberRole(event.target.value as Member["role"])} aria-label="成员角色"><option value="viewer">查看者</option><option value="member">成员</option><option value="editor">编辑者</option></select><Button type="button" size="sm" onClick={() => void addMember()} disabled={memberBusy || !memberEmail.trim()}><Icon name="plus" size={13} />{memberBusy ? "添加中" : "添加成员"}</Button></div>}<div className="project-member-list"><div className="project-member-row project-member-owner"><span className="project-member-avatar"><Icon name="user" size={13} /></span><span><strong>项目所有者</strong><small>Owner</small></span><em>所有者</em></div>{members.map((member) => <div className="project-member-row" key={member.memberId}><span className="project-member-avatar"><Icon name="user" size={13} /></span><span><strong>{member.user?.name || member.user?.email || member.userId}</strong><small>{member.user?.email || "成员"}</small></span>{role === "owner" ? <><select value={member.role} onChange={(event) => void updateMember(member, event.target.value as Member["role"])} aria-label={`${member.user?.email || member.userId} 的角色`}><option value="viewer">查看者</option><option value="member">成员</option><option value="editor">编辑者</option></select><button className="project-context-delete" type="button" onClick={() => void removeMember(member)} aria-label={`移除 ${member.user?.email || member.userId}`} title="移除"><Icon name="trash" size={13} /></button></> : <em>{member.role === "editor" ? "编辑者" : member.role === "member" ? "成员" : "查看者"}</em>}</div>)}</div></section>
      <div className="project-detail-grid"><section className="project-detail-section"><div className="section-heading"><div><span className="eyebrow">任务</span><h2>项目任务</h2></div><Link href="/fw" className="text-link">开始新任务 <Icon name="arrow-up-right" size={13} /></Link></div>{tasks.length ? <div className="project-task-list">{tasks.map((task) => <Link href={`/fw/t/${task.taskId}`} className="project-task-row" key={task.taskId}><span className="project-task-status" data-status={task.status} /><span className="project-task-copy"><strong>{task.title || "未命名任务"}</strong><small>{task.goal}</small></span><span className="project-task-date">{formatDate(task.updatedAt)}</span><Icon name="arrow-right" size={13} /></Link>)}</div> : <div className="project-section-empty">还没有任务。<Link href="/fw">从对话开始</Link></div>}</section>
        <section className="project-detail-section"><div className="section-heading"><div><span className="eyebrow">交付</span><h2>项目成果</h2></div><Link href="/artifacts" className="text-link">查看全部 <Icon name="arrow-up-right" size={13} /></Link></div>{artifacts.length ? <div className="project-artifact-list">{artifacts.slice(0, 8).map((artifact) => <div className="project-artifact-row" key={artifact.artifactId}><Icon name="file" size={14} /><span><strong>{artifact.title}</strong><small>{artifact.taskTitle || artifact.path} · v{artifact.version} · {formatBytes(artifact.bytes)}</small></span>{artifact.previewUrl && <a href={artifact.previewUrl} target="_blank" rel="noreferrer" title="预览" aria-label={`预览 ${artifact.title}`}><Icon name="eye" size={13} /></a>}{artifact.downloadUrl && <a href={artifact.downloadUrl} title="下载" aria-label={`下载 ${artifact.title}`}><Icon name="download" size={13} /></a>}</div>)}</div> : <div className="project-section-empty">完成任务后，交付文件会出现在这里。</div>}</section></div>
      <section className="project-detail-section"><div className="section-heading"><div><span className="eyebrow">重复工作</span><h2>项目自动化</h2></div><Link href="/automations" className="text-link">管理自动化 <Icon name="arrow-up-right" size={13} /></Link></div>{automations.length ? <div className="project-run-list">{automations.map((automation) => <Link href="/automations" className="project-run-row" key={automation.automationId}><span className="project-task-status" data-status={automation.lastRunStatus === "failed" ? "failed" : automation.status === "paused" ? "cancelled" : "active"} /><span><strong>{automation.name}</strong><small>{automation.schedule}{automation.lastRunTaskId ? ` · 最近任务 ${automation.lastRunTaskId}` : ""}{automation.lastError ? ` · ${automation.lastError}` : ""}</small></span><em data-status={automation.lastRunStatus}>{automation.lastRunStatus === "failed" ? "需要重试" : automation.status === "paused" ? "已暂停" : "已启用"}</em><Icon name="arrow-right" size={13} /></Link>)}</div> : <div className="project-section-empty">成功任务可保存为该项目的自动化模板。</div>}</section>
      <section className="project-detail-section project-runs-section"><div className="section-heading"><div><span className="eyebrow">运行记录</span><h2>最近运行</h2></div><span className="section-caption">{runs.length} 次运行</span></div>{runs.length ? <div className="project-run-list">{runs.slice(0, 12).map((run) => <Link href={`/fw/t/${run.taskId}`} className="project-run-row" key={run.runId}><span className="project-task-status" data-status={run.status} /><span><strong>{tasks.find((task) => task.taskId === run.taskId)?.title || "任务运行"}</strong><small>第 {run.attempt} 次尝试 · {formatDate(run.createdAt)}</small></span><em data-status={run.status}>{run.status}</em><Icon name="arrow-right" size={13} /></Link>)}</div> : <div className="project-section-empty">项目还没有运行记录。</div>}</section>
    </>}
  </main>;
}
