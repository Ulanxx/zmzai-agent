"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Button, Icon, IconButton, Textarea } from "@zmzai/theme";

import { ArtifactPreviewCard, EditCard, groupAssistantMessages, MessageView, PermissionCard, PptxPreview } from "@/framework/client/parts";
import { fwApi, useFrameworkSession, type ArtifactCard, type PermissionRequest, type Reply } from "@/framework/client/use-framework-session";

type Workspace = { id: string; name: string; defaultModel: string };
type TaskRecord = { taskId: string; workspaceId: string; title: string; goal: string; status: "draft" | "active" | "succeeded" | "failed" | "cancelled"; activeRunId?: string | null; latestRunId?: string | null; updatedAt?: string };
type RunRecord = { runId: string; taskId: string; sessionId: string; status: "created" | "running" | "waiting_input" | "waiting_approval" | "paused" | "succeeded" | "failed" | "cancelled"; attempt: number; terminalReason?: string | null; createdAt?: string; finishedAt?: string | null };
type TaskListItem = { task: TaskRecord; latestRun: RunRecord | null };
type TaskDetail = { task: TaskRecord; runs: RunRecord[]; session: { id: string; title: string } | null };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = (await response.json().catch(() => null)) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && body !== null && "error" in body ? String(body.error) : "请求失败，请稍后重试");
  return body as T;
}

function statusLabel(status: TaskRecord["status"] | RunRecord["status"] | "idle" | "waiting_permission") {
  const labels: Record<string, string> = {
    draft: "草稿",
    active: "执行中",
    running: "执行中",
    created: "准备中",
    waiting_input: "等待补充",
    waiting_approval: "等待审批",
    waiting_permission: "等待审批",
    paused: "已暂停",
    succeeded: "已完成",
    failed: "需要处理",
    cancelled: "已取消",
    idle: "就绪",
  };
  return labels[status] ?? status;
}

function TaskRail({ tasks, activeTaskId, onNew, onOpen }: { tasks: TaskListItem[]; activeTaskId: string | null; onNew: () => void; onOpen: (taskId: string) => void }) {
  return (
    <aside className="task-rail">
      <div className="task-rail-head">
        <div className="task-brand"><span className="task-brand-mark">z</span><span>zmzai</span></div>
        <IconButton size="md" label="新对话" onClick={onNew}><Icon name="plus" size={15} /></IconButton>
      </div>
      <div className="task-rail-section">
        <span className="task-rail-label">工作</span>
        <Link href="/fw" className="task-rail-link active"><Icon name="message" size={14} />新对话</Link>
        <Link href="/fw" className="task-rail-link"><Icon name="list" size={14} />任务</Link>
        <span className="task-rail-link muted"><Icon name="folder" size={14} />项目</span>
        <span className="task-rail-link muted"><Icon name="archive" size={14} />成果</span>
      </div>
      <div className="task-rail-section task-rail-recent">
        <div className="task-rail-label-row"><span className="task-rail-label">最近任务</span><span className="task-rail-count">{tasks.length}</span></div>
        {tasks.length ? tasks.slice(0, 12).map(({ task, latestRun }) => (
          <button key={task.taskId} type="button" className={`task-list-item ${activeTaskId === task.taskId ? "selected" : ""}`} onClick={() => onOpen(task.taskId)}>
            <span className="task-list-dot" data-status={latestRun?.status ?? task.status} />
            <span className="task-list-copy"><strong>{task.title || "未命名任务"}</strong><small>{statusLabel(latestRun?.status ?? task.status)}</small></span>
          </button>
        )) : <p className="task-rail-empty">完成的任务会出现在这里</p>}
      </div>
      <div className="task-rail-foot"><Link href="/audit"><Icon name="activity" size={13} />运行记录</Link></div>
    </aside>
  );
}

function PlanCard({ todos, taskTools }: { todos: { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }[]; taskTools: unknown[] }) {
  const completed = todos.filter((item) => item.status === "completed").length;
  return (
    <section className="task-structured-card plan-card">
      <div className="structured-card-head"><span className="structured-card-icon"><Icon name="list" size={14} /></span><div><strong>执行计划</strong><small>{todos.length ? `${completed}/${todos.length} 个步骤完成` : `${taskTools.length} 个动作已记录`}</small></div></div>
      {todos.length ? <div className="plan-steps">{todos.map((todo, index) => <div className="plan-step" key={`${todo.content}-${index}`}><span className={`plan-step-mark ${todo.status}`} /> <span>{todo.content}</span></div>)}</div> : <p className="structured-card-note">Agent 会在执行过程中拆解任务，并在关键节点汇报进展。</p>}
    </section>
  );
}

function WorkspacePanel({ artifacts, edits, preview, onOpen, onClose }: { artifacts: ArtifactCard[]; edits: { path: string; revisionId: string; diff: string; at: string }[]; preview: ArtifactCard | null; onOpen: (artifact: ArtifactCard) => void; onClose: () => void }) {
  return (
    <aside className="task-workspace-panel">
      <div className="workspace-panel-head"><div><span className="eyebrow">工作区</span><h2>{preview ? "成果预览" : "任务成果"}</h2></div>{preview && <IconButton size="sm" label="关闭预览" onClick={onClose}><Icon name="cross" size={13} /></IconButton>}</div>
      {preview ? <div className="workspace-preview">
        <div className="workspace-preview-title"><span>{preview.path}</span><a href={preview.downloadUrl} title="下载成果"><Icon name="download" size={14} /></a></div>
        {preview.contentType.includes("presentationml.presentation") ? <PptxPreview previewUrl={preview.previewUrl ?? preview.downloadUrl.replace(/\/download$/, "/preview")} /> : preview.previewUrl ? <iframe src={preview.previewUrl} title={preview.path} sandbox="allow-scripts allow-same-origin" /> : <div className="workspace-no-preview">该成果暂不支持在线预览<br /><a href={preview.downloadUrl}>下载文件</a></div>}
      </div> : <>
        <div className="workspace-panel-tabs"><span className="workspace-tab active">成果 <b>{artifacts.length}</b></span><span className="workspace-tab">改动 <b>{edits.length}</b></span></div>
        <div className="workspace-panel-body">{artifacts.length ? artifacts.map((artifact) => <ArtifactPreviewCard key={artifact.artifactId} artifact={artifact} onOpen={onOpen} />) : <div className="workspace-empty"><Icon name="sparkles" size={20} /><p>任务完成后，网页、文件和数据成果会出现在这里。</p></div>}{edits.length > 0 && <div className="workspace-edits">{edits.map((edit) => <EditCard key={`${edit.revisionId}-${edit.path}`} edit={edit} />)}</div>}</div>
      </>}
    </aside>
  );
}

export function TaskWorkbench({ taskId: routeTaskId, sessionId: routeSessionId }: { taskId: string | null; sessionId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [resolvedTaskId, setResolvedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [replying, setReplying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactCard | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [followScroll, setFollowScroll] = useState(true);

  const taskId = routeTaskId ?? resolvedTaskId;
  const detailMatchesTask = taskDetail?.task.taskId === taskId;
  const sessionId = (detailMatchesTask ? taskDetail?.session?.id : null) ?? routeSessionId;
  const { snapshot, live, loading, loadError } = useFrameworkSession(sessionId);
  const task = (detailMatchesTask ? taskDetail?.task : null) ?? tasks.find((item) => item.task.taskId === taskId)?.task ?? null;
  const latestRun = (detailMatchesTask ? taskDetail?.runs[0] : null) ?? tasks.find((item) => item.task.taskId === taskId)?.latestRun ?? null;
  const busy = live.status !== "idle" || latestRun?.status === "running" || latestRun?.status === "waiting_approval";
  const messages = useMemo(() => groupAssistantMessages(snapshot?.messages ?? []), [snapshot?.messages]);
  const taskTools = useMemo(() => (snapshot?.messages ?? []).flatMap((entry) => entry.parts.filter((part) => part.type === "tool")), [snapshot?.messages]);

  const fetchTasks = useCallback(() => json<{ tasks: TaskListItem[] }>("/api/tasks"), []);

  const fetchTask = useCallback((id: string) => json<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`), []);

  useEffect(() => {
    void Promise.all([fetchTasks(), json<{ workspaces: Workspace[] }>("/api/workspaces")]).then(([taskResult, workspaceResult]) => {
      setTasks(taskResult.tasks);
      setWorkspaces(workspaceResult.workspaces);
      if (routeSessionId && !taskId) {
        const match = taskResult.tasks.find((item) => item.latestRun?.sessionId === routeSessionId);
        if (match) setResolvedTaskId(match.task.taskId);
      }
    }).catch((error: unknown) => setActionError(error instanceof Error ? error.message : "无法加载任务"));
  }, [fetchTasks, routeSessionId, taskId]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void fetchTask(taskId).then((result) => { if (!cancelled) setTaskDetail(result); }).catch((error: unknown) => { if (!cancelled) setActionError(error instanceof Error ? error.message : "无法加载任务详情"); });
    const timer = window.setInterval(() => void fetchTask(taskId).then((result) => { if (!cancelled) setTaskDetail(result); }).catch(() => undefined), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [fetchTask, taskId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && followScroll) element.scrollTop = element.scrollHeight;
  }, [snapshot?.messages, live.todos, followScroll]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === (snapshot?.session.workspaceId ?? task?.workspaceId)) ?? workspaces[0];

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setSending(true);
    setActionError(null);
    try {
      if (sessionId) {
        await fwApi.prompt(sessionId, { text });
      } else if (selectedWorkspace) {
        const created = await fwApi.createSession({ workspaceId: selectedWorkspace.id, model: { providerId: "relay", modelId: selectedWorkspace.defaultModel }, prompt: text });
        if (created.task?.taskId) router.push(`/fw/t/${created.task.taskId}`);
        else router.push(`/fw/s/${created.session.id}`);
      }
      setPrompt("");
      const taskResult = await fetchTasks();
      setTasks(taskResult.tasks);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "发送失败");
    } finally {
      setSending(false);
    }
  }, [fetchTasks, prompt, sending, sessionId, selectedWorkspace, router]);

  const action = useCallback(async (name: "pause" | "resume" | "retry" | "cancel" | "follow_up", text?: string) => {
    if (!taskId) return;
    setActionError(null);
    try {
      await json(`/api/tasks/${encodeURIComponent(taskId)}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: name, ...(text ? { text } : {}) }) });
      const [taskResult, taskListResult] = await Promise.all([fetchTask(taskId), fetchTasks()]);
      setTaskDetail(taskResult);
      setTasks(taskListResult.tasks);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "任务操作失败");
    }
  }, [fetchTask, fetchTasks, taskId]);

  const replyPermission = useCallback(async (reply: Reply, feedback?: string) => {
    if (!sessionId || !live.pendingPermission || replying) return;
    setReplying(true);
    try { await fwApi.replyPermission(sessionId, live.pendingPermission.id, reply, feedback); } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "审批操作失败"); } finally { setReplying(false); }
  }, [live.pendingPermission, replying, sessionId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
  };

  const newTask = () => { setResolvedTaskId(null); setTaskDetail(null); setPrompt(""); router.push("/fw"); };

  if (loading && !snapshot && sessionId) return <main className="task-shell-loading">正在恢复任务…</main>;
  if (loadError) return <main className="task-shell-loading">{loadError}</main>;

  return <main className="task-shell">
    <TaskRail tasks={tasks} activeTaskId={taskId} onNew={newTask} onOpen={(id) => router.push(`/fw/t/${id}`)} />
    <section className="task-content">
      <header className="task-topbar">
        <div className="task-topbar-title"><span className="task-topbar-kicker">{pathname === "/fw" ? "新的工作" : task?.workspaceId ? selectedWorkspace?.name ?? "任务" : "任务"}</span><h1>{task?.title ?? (snapshot?.session.title ?? "开始一个新任务")}</h1></div>
        <div className="task-topbar-actions"><Link href="/fw" className="task-topbar-link">新对话</Link><IconButton size="md" label="刷新任务" onClick={() => { void fetchTasks().then((result) => setTasks(result.tasks)); if (taskId) void fetchTask(taskId).then(setTaskDetail); }}><Icon name="refresh" size={14} /></IconButton></div>
      </header>

      {!sessionId ? <div className="task-home"><div className="task-home-intro"><span className="eyebrow">通用智能体</span><h2>把想做的事交给它。</h2><p>从一句自然语言开始。Agent 会理解目标、拆解步骤、调用工具，并把可用成果交付给你。</p></div><div className="task-composer task-composer-home"><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={handleKeyDown} placeholder="例如：读取 sales.csv，生成一个可预览的销售数据看板" rows={5} /><div className="task-composer-foot"><span>{selectedWorkspace ? `将使用 ${selectedWorkspace.name}` : "正在准备工作区"}</span><Button type="button" onClick={() => void send()} disabled={!prompt.trim() || sending || !selectedWorkspace}><Icon name="arrow-up" size={14} />{sending ? "开始中" : "开始任务"}</Button></div></div><div className="task-examples"><span className="eyebrow">可以从这里开始</span><button type="button" onClick={() => setPrompt("读取 sales.csv，生成一个可预览的销售数据看板，并检查桌面和移动端布局")}>生成数据看板</button><button type="button" onClick={() => setPrompt("分析当前资料，整理成一份带结论和行动建议的报告")}>整理一份报告</button><button type="button" onClick={() => setPrompt("检查当前项目中的代码，找出最需要优先修复的问题")}>检查代码问题</button></div></div> : <div className="task-detail-grid">
        <section className="task-conversation">
          <div className="task-status-strip"><div className="task-status-main"><span className={`task-status-pulse ${busy ? "busy" : ""}`} /><span>{statusLabel(live.pendingPermission ? "waiting_permission" : latestRun?.status ?? live.status)}</span>{latestRun?.attempt && latestRun.attempt > 1 && <small>第 {latestRun.attempt} 次尝试</small>}</div><div className="task-status-actions">{latestRun?.status === "paused" && <Button type="button" variant="secondary" size="sm" onClick={() => void action("resume")}><Icon name="play" size={13} />继续</Button>}{latestRun?.status === "failed" && <Button type="button" variant="secondary" size="sm" onClick={() => void action("retry")}><Icon name="refresh" size={13} />重试</Button>}{busy && <><IconButton size="sm" label="暂停任务" onClick={() => void action("pause")}><Icon name="pause" size={13} /></IconButton><IconButton size="sm" label="取消任务" onClick={() => void action("cancel")}><Icon name="stop" size={13} /></IconButton></>}</div></div>
          <div className="task-message-scroll" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) setFollowScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 160); }}>
            {messages.length ? messages.map((entry, index) => <MessageView key={Array.isArray(entry) ? `assistant-${index}-${entry[0]?.info.id}` : entry.info.id} entry={entry} hideTools={live.todos.length > 0} sessionIdle={live.status === "idle"} />) : <div className="task-empty-conversation"><span className="task-empty-glyph">z</span><p>任务准备完成，开始补充你的要求。</p></div>}
            <PlanCard todos={live.todos} taskTools={taskTools} />
            {live.pendingPermission && <PermissionCard request={live.pendingPermission as PermissionRequest} busy={replying} onReply={(reply, feedback) => void replyPermission(reply, feedback)} />}
            {live.error && <div className="task-error"><Icon name="warning" size={14} /><span>{live.error}</span></div>}
          </div>
          <form className="task-composer task-composer-detail" onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={handleKeyDown} placeholder={busy ? "补充要求会在当前步骤完成后处理…" : "继续这条任务…"} rows={3} /><div className="task-composer-foot"><span>{busy ? "Agent 正在工作" : "Enter 发送 · Shift+Enter 换行"}</span><Button type="submit" disabled={!prompt.trim() || sending}><Icon name="arrow-up" size={14} />发送</Button></div></form>
        </section>
        <WorkspacePanel artifacts={live.artifacts} edits={live.edits} preview={preview} onOpen={setPreview} onClose={() => setPreview(null)} />
      </div>}
      {actionError && <div className="task-toast" role="status">{actionError}</div>}
    </section>
  </main>;
}
