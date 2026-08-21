"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Button, Icon, IconButton, Textarea } from "@zmzai/theme";

import { ArtifactPreviewCard, EditCard, groupAssistantMessages, MessageView, PermissionCard, PptxPreview } from "@/framework/client/parts";
import { fwApi, useFrameworkSession, type ArtifactCard, type Part, type PermissionRequest, type Reply } from "@/framework/client/use-framework-session";

type Workspace = { id: string; name: string; defaultModel: string };
type TaskRecord = { taskId: string; workspaceId: string; projectId?: string | null; title: string; goal: string; status: "draft" | "active" | "succeeded" | "failed" | "cancelled"; activeRunId?: string | null; latestRunId?: string | null; updatedAt?: string };
type RunRecord = { runId: string; taskId: string; sessionId: string; status: "created" | "running" | "waiting_input" | "waiting_approval" | "paused" | "succeeded" | "failed" | "cancelled"; attempt: number; terminalReason?: string | null; createdAt?: string; finishedAt?: string | null };
type TaskListItem = { task: TaskRecord; latestRun: RunRecord | null };
type ApprovalHistory = { requestId: string; action: string; impact: string; resourceScope: string[]; status: "pending" | "approved" | "rejected" | "expired" | "revoked"; decidedAt?: string | null; feedback?: string | null };
type ApprovalGrant = { grantId: string; action: string; resourceScope: string[]; expiresAt: string; sourceRequestId: string };
type SubagentHistory = { subagentRunId: string; parentSubagentRunId?: string | null; childSessionId: string; agent: string; description: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; summary?: string | null; error?: string | null };
type TaskDetail = { task: TaskRecord; runs: RunRecord[]; session: { id: string; title: string } | null; role?: "owner" | "viewer" | "member" | "editor"; approvals?: ApprovalHistory[]; grants?: ApprovalGrant[]; subagents?: SubagentHistory[] };
type ProjectOption = { project: { projectId: string; name: string } };
type QaCheckResult = { status: "passed" | "failed"; checks: { id: string; status: "passed" | "failed"; message: string }[]; viewports: { width: number; height: number; overflow: boolean }[] };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: init?.signal ?? controller.signal });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw new Error("请求超时，请检查服务和登录状态后重试");
    throw cause;
  } finally {
    window.clearTimeout(timeout);
  }
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

function FileAttachments({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  if (!files.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5" aria-label="待上传文件">{files.map((file, index) => <span key={`${file.name}-${file.size}-${file.lastModified}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-2"><Icon name="book" size={12} /><span className="max-w-[14rem] truncate">{file.name}</span><IconButton size="sm" label={`移除 ${file.name}`} onClick={() => onRemove(index)}><Icon name="cross" size={11} /></IconButton></span>)}</div>;
}

function FilePicker({ onFiles }: { onFiles: (files: File[]) => void }) {
  return <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2" title="添加文件"><Icon name="plus" size={12} />添加文件<input type="file" multiple accept=".txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml" className="sr-only" onChange={(event) => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label>;
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
        <Link href="/fw/research" className="task-rail-link"><Icon name="search" size={14} />广泛研究</Link>
        <Link href="/projects" className="task-rail-link"><Icon name="folder" size={14} />项目</Link>
        <Link href="/artifacts" className="task-rail-link"><Icon name="archive" size={14} />成果</Link>
        <Link href="/automations" className="task-rail-link"><Icon name="clock" size={14} />自动化</Link>
        <Link href="/connectors" className="task-rail-link"><Icon name="link" size={14} />连接器</Link>
        <Link href="/developers" className="task-rail-link"><Icon name="key" size={14} />开发者</Link>
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

function PlanCard({ todos, taskTools, onAction, onAdjust, busyIndex }: { todos: { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }[]; taskTools: unknown[]; onAction: (action: "skip" | "rerun", index: number) => void; onAdjust: (instruction: string) => void; busyIndex: number | null }) {
  const completed = todos.filter((item) => item.status === "completed").length;
  const [instruction, setInstruction] = useState("");
  return (
    <section className="task-structured-card plan-card">
      <div className="structured-card-head"><span className="structured-card-icon"><Icon name="list" size={14} /></span><div><strong>执行计划</strong><small>{todos.length ? `${completed}/${todos.length} 个步骤完成` : `${taskTools.length} 个动作已记录`}</small></div></div>
      {todos.length ? <div className="plan-steps">{todos.map((todo, index) => <div className="plan-step" key={`${todo.content}-${index}`}><span className={`plan-step-mark ${todo.status}`} /> <span className="plan-step-copy">{todo.content}</span>{(todo.status === "pending" || todo.status === "in_progress") && <IconButton size="sm" label={`跳过第 ${index + 1} 步`} disabled={busyIndex === index} onClick={() => onAction("skip", index)}><Icon name="stop" size={12} /></IconButton>}{todo.status === "completed" && <IconButton size="sm" label={`重跑第 ${index + 1} 步`} disabled={busyIndex === index} onClick={() => onAction("rerun", index)}><Icon name="refresh" size={12} /></IconButton>}</div>)}</div> : <p className="structured-card-note">Agent 会在执行过程中拆解任务，并在关键节点汇报进展。</p>}
      <details className="plan-adjust"><summary>调整计划</summary><div className="plan-adjust-form"><input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：先完成网页，再做质量检查" aria-label="计划调整内容" /><Button type="button" variant="secondary" size="sm" disabled={!instruction.trim() || busyIndex !== null} onClick={() => { onAdjust(instruction.trim()); setInstruction(""); }}>应用</Button></div></details>
    </section>
  );
}

function QualityCard({ result }: { result: QaCheckResult }) {
  const passed = result.checks.filter((check) => check.status === "passed").length;
  return <section className={`task-structured-card quality-card ${result.status}`}>
    <div className="structured-card-head"><span className="structured-card-icon"><Icon name={result.status === "passed" ? "check" : "warning"} size={14} /></span><div><strong>质量检查</strong><small>{passed}/{result.checks.length} 项通过</small></div><span className="quality-status">{result.status === "passed" ? "通过" : "需要修复"}</span></div>
    <div className="quality-checks">{result.checks.map((check) => <div className="quality-check" key={check.id}><span className={`quality-check-mark ${check.status}`} /> <span>{check.message}</span></div>)}</div>
  </section>;
}

function ApprovalHistoryCard({ approvals, grants, onRevoke, revokingId }: { approvals: ApprovalHistory[]; grants: ApprovalGrant[]; onRevoke: (grantId: string) => void; revokingId: string | null }) {
  const resolved = approvals.filter((approval) => approval.status !== "pending");
  if (!resolved.length && !grants.length) return null;
  return <section className="task-structured-card approval-history-card">
    <div className="structured-card-head"><span className="structured-card-icon"><Icon name="shield" size={14} /></span><div><strong>授权记录</strong><small>{grants.length ? `${grants.length} 项持续授权 · ${resolved.length} 项已处理` : `${resolved.length} 项已处理`}</small></div></div>
    <div className="approval-history-list">{grants.map((grant) => <div key={grant.grantId} className="approval-grant-row"><div><span className="approved">持续授权</span><p>{grant.action} · {grant.resourceScope.join("、")}</p><small>有效至 {new Date(grant.expiresAt).toLocaleString("zh-CN")}</small></div><IconButton size="sm" label="撤销持续授权" disabled={revokingId === grant.grantId} onClick={() => onRevoke(grant.grantId)}><Icon name="trash" size={13} /></IconButton></div>)}{resolved.slice(0, 5).map((approval) => <div key={approval.requestId}><span className={approval.status}>{approval.status === "approved" ? "已允许" : approval.status === "rejected" ? "已拒绝" : approval.status}</span><p>{approval.impact}</p>{approval.feedback && <small>{approval.feedback}</small>}</div>)}</div>
  </section>;
}

function SubagentCard({ subagents, onRetry, retryingId }: { subagents: SubagentHistory[]; onRetry: (id: string) => void; retryingId: string | null }) {
  if (!subagents.length) return null;
  return <section className="task-structured-card subagent-card">
    <div className="structured-card-head"><span className="structured-card-icon"><Icon name="sparkles" size={14} /></span><div><strong>协作任务</strong><small>{subagents.filter((subagent) => subagent.status === "completed").length}/{subagents.length} 已完成</small></div></div>
    <div className="subagent-list">{subagents.map((subagent) => <div key={subagent.subagentRunId} className="subagent-row"><span className={`subagent-status ${subagent.status}`} /><div><strong>{subagent.description}</strong><small>{subagent.agent} · {subagent.status === "completed" ? "已完成" : subagent.status === "failed" ? "需要重试" : "执行中"}</small>{subagent.summary && <p>{subagent.summary}</p>}{subagent.error && <p className="subagent-error">{subagent.error}</p>}</div>{subagent.status === "failed" && <IconButton size="sm" label="重试此子任务" disabled={retryingId === subagent.subagentRunId} onClick={() => onRetry(subagent.subagentRunId)}><Icon name="refresh" size={13} /></IconButton>}</div>)}</div>
  </section>;
}

function CompletionCard({ artifacts, onFollowUp, onSaveTemplate, savingTemplate, onSaveSkill, savingSkill, canSave }: { artifacts: ArtifactCard[]; onFollowUp: () => void; onSaveTemplate: () => void; savingTemplate: boolean; onSaveSkill: () => void; savingSkill: boolean; canSave: boolean }) {
  return <section className="task-structured-card completion-card">
    <div className="structured-card-head"><span className="structured-card-icon"><Icon name="check" size={14} /></span><div><strong>任务已完成</strong><small>{artifacts.length ? `${artifacts.length} 个成果已准备好` : "结果已整理到对话中"}</small></div></div>
    <div className="completion-actions"><Button type="button" variant="secondary" size="sm" onClick={onFollowUp}><Icon name="message" size={13} />继续修改</Button>{canSave && <><Button type="button" variant="secondary" size="sm" onClick={onSaveSkill} disabled={savingSkill}><Icon name="sparkles" size={13} />{savingSkill ? "保存中" : "保存 Skill"}</Button><Button type="button" variant="secondary" size="sm" onClick={onSaveTemplate} disabled={savingTemplate}><Icon name="clock" size={13} />{savingTemplate ? "保存中" : "保存模板"}</Button></>}{artifacts.length > 0 && <span className="completion-hint">可在右侧预览或下载</span>}</div>
  </section>;
}

type WorkspaceTab = "files" | "diff" | "terminal" | "preview" | "artifacts";
type ToolPart = Extract<Part, { type: "tool" }>;

function toolOutput(tool: ToolPart): string {
  if (tool.state.status === "completed") return tool.state.output;
  if (tool.state.status === "error") return tool.state.error;
  if (tool.state.status === "running") return tool.state.title ?? "执行中";
  return "等待执行";
}

function WorkspacePanel({ artifacts, edits, files, tools, preview, activeTab, onTabChange, onOpen, onClose }: { artifacts: ArtifactCard[]; edits: { path: string; revisionId: string; diff: string; at: string }[]; files: string[]; tools: ToolPart[]; preview: ArtifactCard | null; activeTab: WorkspaceTab; onTabChange: (tab: WorkspaceTab) => void; onOpen: (artifact: ArtifactCard) => void; onClose: () => void }) {
  const tabs: Array<{ id: WorkspaceTab; label: string; count: number }> = [{ id: "files", label: "文件", count: files.length }, { id: "diff", label: "改动", count: edits.length }, { id: "terminal", label: "终端", count: tools.length }, { id: "preview", label: "预览", count: preview ? 1 : 0 }, { id: "artifacts", label: "成果", count: artifacts.length }];
  const showPreview = activeTab === "preview" && preview;
  return (
    <aside className="task-workspace-panel">
      <div className="workspace-panel-head"><div><span className="eyebrow">工作区</span><h2>{showPreview ? "成果预览" : "任务工作区"}</h2></div>{preview && <IconButton size="sm" label="关闭预览" onClick={onClose}><Icon name="cross" size={13} /></IconButton>}</div>
      <div className="workspace-panel-tabs" role="tablist">{tabs.map((tab) => <button type="button" role="tab" aria-selected={activeTab === tab.id} className={`workspace-tab ${activeTab === tab.id ? "active" : ""}`} key={tab.id} onClick={() => onTabChange(tab.id)}>{tab.label} <b>{tab.count}</b></button>)}</div>
      {showPreview ? <div className="workspace-preview">
        <div className="workspace-preview-title"><span>{preview.path}</span><a href={preview.downloadUrl} title="下载成果"><Icon name="download" size={14} /></a></div>
        {preview.contentType.includes("presentationml.presentation") ? <PptxPreview previewUrl={preview.previewUrl ?? preview.downloadUrl.replace(/\/download$/, "/preview")} /> : preview.previewUrl ? <iframe src={preview.previewUrl} title={preview.path} sandbox="allow-scripts allow-same-origin" /> : <div className="workspace-no-preview">该成果暂不支持在线预览<br /><a href={preview.downloadUrl}>下载文件</a></div>}
      </div> : <div className="workspace-panel-body">
        {activeTab === "files" && (files.length ? <div className="workspace-file-list">{files.map((file) => <div className="workspace-file-row" key={file}><Icon name="file" size={13} /><span>{file}</span></div>)}</div> : <div className="workspace-empty"><Icon name="file" size={20} /><p>上传或生成的文件会出现在这里。</p></div>)}
        {activeTab === "diff" && (edits.length ? <div className="workspace-edits">{edits.map((edit) => <EditCard key={`${edit.revisionId}-${edit.path}`} edit={edit} />)}</div> : <div className="workspace-empty"><Icon name="edit" size={20} /><p>任务产生文件改动后，会在这里显示差异。</p></div>)}
        {activeTab === "terminal" && (tools.length ? <div className="workspace-terminal-list">{tools.slice(-30).map((tool) => <div className={`workspace-terminal-row ${tool.state.status}`} key={tool.id}><div><strong>{tool.tool}</strong><small>{toolOutput(tool)}</small></div><span>{tool.state.status}</span></div>)}</div> : <div className="workspace-empty"><Icon name="activity" size={20} /><p>Agent 调用终端或工具后，会在这里保留摘要。</p></div>)}
        {activeTab === "artifacts" && (artifacts.length ? artifacts.map((artifact) => <ArtifactPreviewCard key={artifact.artifactId} artifact={artifact} onOpen={onOpen} />) : <div className="workspace-empty"><Icon name="sparkles" size={20} /><p>任务完成后，网页、文件和数据成果会出现在这里。</p></div>)}
        {activeTab === "preview" && <div className="workspace-empty"><Icon name="eye" size={20} /><p>从成果 Tab 选择一个文件开始预览。</p></div>}
      </div>}
    </aside>
  );
}

export function TaskWorkbench({ taskId: routeTaskId, sessionId: routeSessionId }: { taskId: string | null; sessionId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [resolvedTaskId, setResolvedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [researchMode, setResearchMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [replying, setReplying] = useState(false);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [retryingSubagentId, setRetryingSubagentId] = useState<string | null>(null);
  const [planBusyIndex, setPlanBusyIndex] = useState<number | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savingSkill, setSavingSkill] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [preview, setPreview] = useState<ArtifactCard | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("artifacts");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [followScroll, setFollowScroll] = useState(true);

  const taskId = routeTaskId ?? resolvedTaskId;
  const detailMatchesTask = taskDetail?.task.taskId === taskId;
  const sessionId = (detailMatchesTask ? taskDetail?.session?.id : null) ?? routeSessionId;
  const { snapshot, live, loading, loadError } = useFrameworkSession(sessionId);
  const task = (detailMatchesTask ? taskDetail?.task : null) ?? tasks.find((item) => item.task.taskId === taskId)?.task ?? null;
  const canEditTask = !task?.projectId || taskDetail?.role === "owner" || taskDetail?.role === "editor";
  const latestRun = (detailMatchesTask ? taskDetail?.runs[0] : null) ?? tasks.find((item) => item.task.taskId === taskId)?.latestRun ?? null;
  const busy = live.status === "running" || live.status === "waiting_permission" || latestRun?.status === "running" || latestRun?.status === "waiting_approval";
  const messages = useMemo(() => groupAssistantMessages(snapshot?.messages ?? []), [snapshot?.messages]);
  const taskTools = useMemo(() => (snapshot?.messages ?? []).flatMap((entry) => entry.parts.filter((part): part is ToolPart => part.type === "tool")), [snapshot?.messages]);
  const taskFiles = useMemo(() => [...new Set([...(snapshot?.messages ?? []).flatMap((entry) => entry.parts.flatMap((part) => part.type === "file" ? [part.filename] : [])), ...live.edits.map((edit) => edit.path)])], [live.edits, snapshot?.messages]);
  const qualityResult = useMemo(() => {
    for (const message of [...(snapshot?.messages ?? [])].reverse()) {
      for (const part of [...message.parts].reverse()) {
        if (part.type !== "tool" || part.tool !== "qa-check" || part.state.status !== "completed") continue;
        const value = part.state.metadata?.qaCheck;
        if (!value || typeof value !== "object") continue;
        const candidate = value as Partial<QaCheckResult>;
        if ((candidate.status === "passed" || candidate.status === "failed") && Array.isArray(candidate.checks) && Array.isArray(candidate.viewports)) return candidate as QaCheckResult;
      }
    }
    return null;
  }, [snapshot?.messages]);

  const fetchTasks = useCallback(() => json<{ tasks: TaskListItem[] }>("/api/tasks"), []);

  const fetchTask = useCallback((id: string) => json<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`), []);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceLoading(true);
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      setWorkspaceLoading(false);
      setActionError((current) => current ?? "工作区加载超时，请检查登录状态后重试");
    }, 8_000);
    void Promise.allSettled([fetchTasks(), json<{ workspaces: Workspace[] }>("/api/workspaces"), json<{ projects: ProjectOption[] }>("/api/projects")]).then(([taskResult, workspaceResult, projectResult]) => {
      if (cancelled) return;
      window.clearTimeout(timeout);
      if (taskResult.status === "fulfilled") {
        setTasks(taskResult.value.tasks);
        if (routeSessionId && !taskId) {
          const match = taskResult.value.tasks.find((item) => item.latestRun?.sessionId === routeSessionId);
          if (match) setResolvedTaskId(match.task.taskId);
        }
      }
      if (workspaceResult.status === "fulfilled") setWorkspaces(workspaceResult.value.workspaces);
      if (projectResult.status === "fulfilled") setProjects(projectResult.value.projects);
      const firstFailure = [workspaceResult, taskResult, projectResult].find((result) => result.status === "rejected");
      if (firstFailure?.status === "rejected") setActionError(firstFailure.reason instanceof Error ? firstFailure.reason.message : "无法加载工作区");
      setWorkspaceLoading(false);
    });
    return () => { cancelled = true; window.clearTimeout(timeout); };
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

  const uploadFiles = useCallback(async (id: string, files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) await fwApi.uploadFile(id, file);
    } finally {
      setUploading(false);
    }
  }, []);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sending || uploading) return;
    const files = selectedFiles;
    setSending(true);
    setActionError(null);
    try {
      if (researchMode && !sessionId && selectedWorkspace) {
        const body = new FormData();
        body.set("workspaceId", selectedWorkspace.id);
        body.set("question", text);
        body.set("maxConcurrency", "3");
        for (const file of files) body.append("files", file);
        const result = await json<{ taskId: string }>("/api/research", {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body,
        });
        setPrompt("");
        setSelectedFiles([]);
        setResearchMode(false);
        router.push(`/fw/t/${result.taskId}`);
        return;
      }
      if (sessionId) {
        await uploadFiles(sessionId, files);
        await fwApi.prompt(sessionId, { text });
      } else if (selectedWorkspace) {
        const created = await fwApi.createSession({ workspaceId: selectedWorkspace.id, model: { providerId: "relay", modelId: selectedWorkspace.defaultModel }, ...(taskId ? { taskId } : {}), ...(files.length ? {} : { prompt: text }) });
        if (files.length) {
          await uploadFiles(created.session.id, files);
          await fwApi.prompt(created.session.id, { text });
        }
        if (created.task?.taskId) router.push(`/fw/t/${created.task.taskId}`);
        else router.push(`/fw/s/${created.session.id}`);
      }
      setPrompt("");
      setSelectedFiles([]);
      const taskResult = await fetchTasks();
      setTasks(taskResult.tasks);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "发送失败");
    } finally {
      setSending(false);
    }
  }, [fetchTasks, prompt, researchMode, sending, uploading, selectedFiles, sessionId, selectedWorkspace, router, uploadFiles, taskId]);

  const action = useCallback(async (name: "pause" | "resume" | "retry" | "cancel" | "follow_up", text?: string) => {
    if (!taskId) return;
    setActionError(null);
    try {
      await json(`/api/tasks/${encodeURIComponent(taskId)}/actions`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ action: name, ...(text ? { text } : {}) }) });
      const [taskResult, taskListResult] = await Promise.all([fetchTask(taskId), fetchTasks()]);
      setTaskDetail(taskResult);
      setTasks(taskListResult.tasks);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "任务操作失败");
    }
  }, [fetchTask, fetchTasks, taskId]);

  const assignProject = useCallback(async (projectId: string) => {
    if (!taskId) return;
    try {
      const result = await json<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: projectId || null }) });
      setTaskDetail((current) => current && current.task.taskId === taskId ? { ...current, task: result.task } : current);
      const taskResult = await fetchTasks();
      setTasks(taskResult.tasks);
    } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "更新项目归属失败"); }
  }, [fetchTasks, taskId]);

  const replyPermission = useCallback(async (reply: Reply, feedback?: string) => {
    if (!sessionId || !live.pendingPermission || replying) return;
    setReplying(true);
    try { await fwApi.replyPermission(sessionId, live.pendingPermission.id, reply, feedback); } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "审批操作失败"); } finally { setReplying(false); }
  }, [live.pendingPermission, replying, sessionId]);

  const revokeGrant = useCallback(async (grantId: string) => {
    if (!taskId || revokingGrantId) return;
    setRevokingGrantId(grantId);
    try {
      await json(`/api/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(grantId)}`, { method: "DELETE" });
      setTaskDetail(await fetchTask(taskId));
    } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "撤销授权失败"); }
    finally { setRevokingGrantId(null); }
  }, [fetchTask, revokingGrantId, taskId]);

  const retrySubagent = useCallback(async (subagentRunId: string) => {
    if (!taskId || retryingSubagentId) return;
    setRetryingSubagentId(subagentRunId);
    try {
      await json(`/api/tasks/${encodeURIComponent(taskId)}/subagents/${encodeURIComponent(subagentRunId)}/retry`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } });
      setTaskDetail(await fetchTask(taskId));
    } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "子任务重试失败"); } finally { setRetryingSubagentId(null); }
  }, [fetchTask, retryingSubagentId, taskId]);

  const planAction = useCallback(async (actionName: "skip" | "rerun" | "adjust", index: number, instruction?: string) => {
    if (!taskId || planBusyIndex !== null) return;
    setPlanBusyIndex(index);
    try {
      await json(`/api/tasks/${encodeURIComponent(taskId)}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: actionName, ...(actionName === "adjust" ? { instruction } : { index }) }) });
      setTaskDetail(await fetchTask(taskId));
    } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "计划操作失败"); }
    finally { setPlanBusyIndex(null); }
  }, [fetchTask, planBusyIndex, taskId]);

  const adjustPlan = useCallback((instruction: string) => { void planAction("adjust", -1, instruction); }, [planAction]);

  const branchTask = useCallback(async () => {
    if (!taskId) return;
    try {
      const result = await json<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(taskId)}/branch`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) });
      router.push(`/fw/t/${result.task.taskId}`);
    } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "创建任务分支失败"); }
  }, [router, taskId]);

  const saveTemplate = useCallback(async () => {
    if (!taskId || savingTemplate) return;
    setSavingTemplate(true);
    try {
      await json(`/api/tasks/${encodeURIComponent(taskId)}/automation`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) });
      router.push("/automations");
    } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "保存模板失败"); }
    finally { setSavingTemplate(false); }
  }, [router, savingTemplate, taskId]);

  const saveSkill = useCallback(async () => {
    if (!taskId || savingSkill) return;
    setSavingSkill(true);
    try {
      await json(`/api/tasks/${encodeURIComponent(taskId)}/skill`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) });
      setActionError("已保存并启用到当前 Workspace");
    } catch (error: unknown) { setActionError(error instanceof Error ? error.message : "保存 Skill 失败"); }
    finally { setSavingSkill(false); }
  }, [savingSkill, taskId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
  };

  const newTask = () => { setResolvedTaskId(null); setTaskDetail(null); setPrompt(""); setResearchMode(false); router.push("/fw"); };

  if (loading && !snapshot && sessionId) return <main className="task-shell-loading">正在恢复任务…</main>;
  if (loadError) return <main className="task-shell-loading">{loadError}</main>;

  return <main className="task-shell">
    <TaskRail tasks={tasks} activeTaskId={taskId} onNew={newTask} onOpen={(id) => router.push(`/fw/t/${id}`)} />
    <section className="task-content">
      <header className="task-topbar">
        <div className="task-topbar-title"><span className="task-topbar-kicker">{pathname === "/fw" ? "新的工作" : task?.workspaceId ? selectedWorkspace?.name ?? "任务" : "任务"}</span><h1>{task?.title ?? (snapshot?.session.title ?? "开始一个新任务")}</h1></div>
        <div className="task-topbar-actions">{task && canEditTask && <select className="task-project-select" value={task.projectId ?? ""} onChange={(event) => void assignProject(event.target.value)} aria-label="项目归属"><option value="">未加入项目</option>{projects.map(({ project }) => <option value={project.projectId} key={project.projectId}>{project.name}</option>)}</select>}<Link href="/fw" className="task-topbar-link">新对话</Link><IconButton size="md" label="刷新任务" onClick={() => { void fetchTasks().then((result) => setTasks(result.tasks)); if (taskId) void fetchTask(taskId).then(setTaskDetail); }}><Icon name="refresh" size={14} /></IconButton></div>
      </header>

      {!sessionId ? <div className="task-home"><div className="task-home-intro"><span className="eyebrow">通用智能体</span><h2>把想做的事交给它。</h2><p>从一句自然语言开始。Agent 会理解目标、拆解步骤、调用工具，并把可用成果交付给你。</p></div><div className="task-composer task-composer-home"><div className="task-mode-row"><button type="button" className={`task-mode-toggle ${researchMode ? "active" : ""}`} onClick={() => setResearchMode((current) => !current)}><Icon name="search" size={13} />{researchMode ? "广泛研究模式" : "普通任务模式"}</button>{researchMode && <span>将并行核验多个研究视角</span>}</div><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={handleKeyDown} placeholder={researchMode ? "例如：比较 AI Agent 平台的产品能力和商业模式" : "例如：读取 sales.csv，生成一个可预览的销售数据看板"} rows={5} /><FileAttachments files={selectedFiles} onRemove={(index) => setSelectedFiles((current) => current.filter((_, item) => item !== index))} /><div className="task-composer-foot"><div className="flex items-center gap-2"><FilePicker onFiles={(files) => setSelectedFiles((current) => [...current, ...files].slice(0, 10))} /><span>{selectedWorkspace ? `将使用 ${selectedWorkspace.name}` : workspaceLoading ? "正在准备工作区" : "无法加载工作区"}</span></div><Button type="button" onClick={() => void send()} disabled={!prompt.trim() || sending || uploading || !selectedWorkspace}><Icon name="arrow-up" size={14} />{sending || uploading ? "准备中" : "开始任务"}</Button></div></div><div className="task-examples"><span className="eyebrow">可以从这里开始</span><button type="button" onClick={() => { setPrompt("读取 sales.csv，生成一个可预览的销售数据看板，并检查桌面和移动端布局"); setResearchMode(false); }}>生成数据看板</button><button type="button" onClick={() => { setPrompt("分析当前资料，整理成一份带结论和行动建议的报告"); setResearchMode(false); }}>整理一份报告</button><button type="button" onClick={() => { setPrompt("检查当前项目中的代码，找出最需要优先修复的问题"); setResearchMode(false); }}>检查代码问题</button><button type="button" onClick={() => { setPrompt("比较主流 AI Agent 平台的能力、交互和商业模式，并给出可执行结论"); setResearchMode(true); }}>广泛研究</button></div></div> : <div className="task-detail-grid">
        <section className="task-conversation">
          <div className="task-status-strip"><div className="task-status-main"><span className={`task-status-pulse ${busy ? "busy" : ""}`} /><span>{statusLabel(live.pendingPermission ? "waiting_permission" : latestRun?.status ?? live.status)}</span>{latestRun?.attempt && latestRun.attempt > 1 && <small>第 {latestRun.attempt} 次尝试</small>}</div><div className="task-status-actions">{(taskDetail?.role === "owner" || taskDetail?.role === "editor") && <IconButton size="sm" label="创建任务分支" onClick={() => void branchTask()}><Icon name="copy" size={13} /></IconButton>}{latestRun?.status === "paused" && <Button type="button" variant="secondary" size="sm" onClick={() => void action("resume")}><Icon name="play" size={13} />继续</Button>}{latestRun?.status === "failed" && <Button type="button" variant="secondary" size="sm" onClick={() => void action("retry")}><Icon name="refresh" size={13} />重试</Button>}{busy && <><IconButton size="sm" label="暂停任务" onClick={() => void action("pause")}><Icon name="pause" size={13} /></IconButton><IconButton size="sm" label="取消任务" onClick={() => void action("cancel")}><Icon name="stop" size={13} /></IconButton></>}</div></div>
          <div className="task-message-scroll" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) setFollowScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 160); }}>
            {messages.length ? messages.map((entry, index) => <MessageView key={Array.isArray(entry) ? `assistant-${index}-${entry[0]?.info.id}` : entry.info.id} entry={entry} hideTools={live.todos.length > 0} sessionIdle={live.status === "idle"} />) : <div className="task-empty-conversation"><span className="task-empty-glyph">z</span><p>任务准备完成，开始补充你的要求。</p></div>}
            <PlanCard todos={live.todos} taskTools={taskTools} onAction={(actionName, index) => void planAction(actionName, index)} onAdjust={adjustPlan} busyIndex={planBusyIndex} />
            {qualityResult && <QualityCard result={qualityResult} />}
            {live.pendingPermission && <PermissionCard request={live.pendingPermission as PermissionRequest} busy={replying} onReply={(reply, feedback) => void replyPermission(reply, feedback)} />}
            <SubagentCard subagents={taskDetail?.subagents ?? []} onRetry={(id) => void retrySubagent(id)} retryingId={retryingSubagentId} />
            <ApprovalHistoryCard approvals={taskDetail?.approvals ?? []} grants={taskDetail?.grants ?? []} onRevoke={(id) => void revokeGrant(id)} revokingId={revokingGrantId} />
            {live.error && <div className="task-error"><Icon name="warning" size={14} /><span>{live.error}</span></div>}
            {(latestRun?.status === "succeeded" || task?.status === "succeeded") && <CompletionCard artifacts={live.artifacts} onFollowUp={() => setPrompt("请继续修改这个成果，并说明你准备调整的内容") } onSaveTemplate={() => void saveTemplate()} savingTemplate={savingTemplate} onSaveSkill={() => void saveSkill()} savingSkill={savingSkill} canSave={canEditTask} />}
          </div>
          <form className="task-composer task-composer-detail" onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={handleKeyDown} placeholder={busy ? "补充要求会在当前步骤完成后处理…" : "继续这条任务…"} rows={3} /><FileAttachments files={selectedFiles} onRemove={(index) => setSelectedFiles((current) => current.filter((_, item) => item !== index))} /><div className="task-composer-foot"><div className="flex items-center gap-2"><FilePicker onFiles={(files) => setSelectedFiles((current) => [...current, ...files].slice(0, 10))} /><span>{uploading ? "文件上传中" : busy ? "Agent 正在工作" : "Enter 发送 · Shift+Enter 换行"}</span></div><Button type="submit" disabled={!prompt.trim() || sending || uploading}><Icon name="arrow-up" size={14} />{sending || uploading ? "准备中" : "发送"}</Button></div></form>
        </section>
        <WorkspacePanel artifacts={live.artifacts} edits={live.edits} files={taskFiles} tools={taskTools} preview={preview} activeTab={workspaceTab} onTabChange={setWorkspaceTab} onOpen={(artifact) => { setPreview(artifact); setWorkspaceTab("preview"); }} onClose={() => { setPreview(null); setWorkspaceTab("artifacts"); }} />
      </div>}
      {actionError && <div className="task-toast" role="status">{actionError}</div>}
    </section>
  </main>;
}
