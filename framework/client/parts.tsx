"use client";

import { useState } from "react";

import { DiffView } from "@/components/diff-view";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import type { ArtifactCard, FileEdit, PermissionRequest, Reply, TodoItem } from "@/framework/client/use-framework-session";
import type { MessageWithParts, Part } from "@/framework/core/session/types";

/** Part renderers (spec §10.2): the conversation stream renders directly from
 *  the part list — text/reasoning/tool/step parts inline, approvals as inline
 *  cards, todos as a pinned checklist, artifacts as preview cards. */

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function toolDuration(part: Extract<Part, { type: "tool" }>): string | null {
  if (part.state.status !== "completed" && part.state.status !== "error") return null;
  const duration = new Date(part.state.time.end).getTime() - new Date(part.state.time.start).getTime();
  if (!Number.isFinite(duration) || duration < 0) return null;
  return duration >= 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`;
}

type ToolPart = Extract<Part, { type: "tool" }>;

function ToolPartCard({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const state = part.state;
  const running = state.status === "running" || state.status === "pending";
  const title = state.status === "completed" ? state.title : state.status === "running" ? (state.title ?? part.tool) : part.tool;
  const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : null;
  const statusClass = state.status === "completed" ? "completed" : state.status === "error" ? "failed" : "running";

  // Running tools are always open. Once a terminal state arrives, `expanded`
  // remains false unless the user explicitly opens the output.
  const isOpen = running || expanded;

  return (
    <div className={`tool-card ${statusClass}`}>
      <button type="button" className="tool-card-trigger" aria-expanded={isOpen} onClick={() => setExpanded((value) => !value)}>
        <span className="tool-card-glyph" aria-hidden><Icon name={state.status === "completed" ? "check" : state.status === "error" ? "cross" : "chevron-down"} size={12} /></span>
        <span className="tool-card-label">{title}</span>
        {toolDuration(part) && <span className="tool-card-duration">{toolDuration(part)}</span>}
        <Icon name="chevron-down" size={12} className={isOpen ? "tool-card-chevron open" : "tool-card-chevron"} />
      </button>
      {isOpen && (
        <div className="tool-card-detail">
          <div className="tool-card-detail-section">
            <span className="tool-card-detail-label">输入</span>
            <pre>{formatToolInput(state.input)}</pre>
          </div>
          {output !== null && (
            <div className="tool-card-detail-section">
              <span className="tool-card-detail-label">输出</span>
              <pre>{output}</pre>
            </div>
          )}
          {running && <span className="tool-card-live-note">正在等待工具返回结果…</span>}
        </div>
      )}
    </div>
  );
}

function TextPart({ part }: { part: Extract<Part, { type: "text" }> }) {
  return <div className="fw-message-content"><Markdown text={part.text} /></div>;
}

function ReasoningPart({ part, active }: { part: Extract<Part, { type: "reasoning" }>; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fw-reasoning">
      <button type="button" className="fw-reasoning-toggle" aria-expanded={active || open} onClick={() => setOpen((value) => !value)}>
        <span className="fw-reasoning-dot" aria-hidden />
        <span>思考过程</span>
        <Icon name="chevron-down" size={11} className={active || open ? "fw-chevron open" : "fw-chevron"} />
      </button>
      {(active || open) && <pre className="fw-reasoning-body">{part.text}</pre>}
    </div>
  );
}

function SubtaskPart({ part }: { part: Extract<Part, { type: "subtask" }> }) {
  return (
    <div className="fw-subtask-row">
      <span className="fw-subtask-icon" aria-hidden><Icon name="chevron-down" size={12} /></span>
      <span className="fw-subtask-copy"><strong>{part.description || part.agent}</strong><small>{part.prompt}</small></span>
      <span className="fw-subtask-state">子任务</span>
    </div>
  );
}

export function MessageView({ entry: source, hideTools = false }: { entry: MessageWithParts | MessageWithParts[]; hideTools?: boolean }) {
  const entries = Array.isArray(source) ? source : [source];
  const entry = entries[0];
  if (!entry) return null;
  if (entry.info.role === "user") {
    const text = entry.parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!text.trim()) return null;
    return <div className="fw-message user"><span className="fw-message-avatar">你</span><div className="fw-message-column"><div className="fw-message-meta"><strong>你</strong><span>用户</span></div><div className="fw-message-content">{text}</div></div></div>;
  }
  const assistantEntries = entries.filter((item) => item.info.role === "assistant");
  const active = assistantEntries.some((item) => !("completed" in item.info.time) || !item.info.time.completed);
  const parts = entries.flatMap((item) => item.parts);
  const errorEntry = assistantEntries.find((item) => "error" in item.info && item.info.error);
  const error = errorEntry && "error" in errorEntry.info ? errorEntry.info.error : undefined;
  const renderedParts = parts.map((part) => {
    switch (part.type) {
      case "text":
        return <TextPart key={part.id} part={part} />;
      case "reasoning":
        return <ReasoningPart key={part.id} part={part} active={active} />;
      case "tool":
        return hideTools ? null : <ToolPartCard key={`${part.id}:${part.state.status}`} part={part} />;
      case "subtask":
        return <SubtaskPart key={part.id} part={part} />;
      case "step-start":
      case "step-finish":
        return null;
      default:
        return null;
    }
  });
  return (
    <div className="fw-message assistant">
      <span className="fw-message-avatar assistant">使</span>
      <div className="fw-message-column">
      <div className="fw-message-meta"><strong>ZMZAI Agent</strong><span>{active ? "执行中" : "已完成"}</span></div>
      <div className="fw-execution-tree">{renderedParts}</div>
      {error && <div className="run-note">出错了：{error.message}</div>}
      </div>
    </div>
  );
}

/** The event projector can persist several assistant messages during one run.
 * Present them as one continuous assistant turn, like the Workshop transcript. */
export function groupAssistantMessages(messages: MessageWithParts[]): Array<MessageWithParts | MessageWithParts[]> {
  const grouped: Array<MessageWithParts | MessageWithParts[]> = [];
  let assistantGroup: MessageWithParts[] = [];
  const flush = () => {
    if (assistantGroup.length === 1) grouped.push(assistantGroup[0]);
    else if (assistantGroup.length > 1) grouped.push(assistantGroup);
    assistantGroup = [];
  };
  for (const message of messages) {
    if (message.info.role === "assistant") assistantGroup.push(message);
    else {
      flush();
      grouped.push(message);
    }
  }
  flush();
  return grouped;
}

export function PermissionCard({ request, busy, onReply }: { request: PermissionRequest; busy: boolean; onReply: (reply: Reply, feedback?: string) => void }) {
  const [feedback, setFeedback] = useState("");
  const command = typeof (request.metadata as { command?: unknown } | undefined)?.command === "string" ? (request.metadata as { command: string }).command : null;
  return (
    <article className="fw-permission-card">
      <div className="fw-permission-head">
        <span className="fw-permission-badge">{request.permission}</span>
        <strong>{command ?? request.patterns.join("、")}</strong>
      </div>
      <p className="fw-permission-note">
        {request.permission === "bash" ? "Agent 请求在隔离沙箱中执行这条命令。批准后本次运行一次有效；选择「始终允许」则同任务内同类命令不再询问。" : "Agent 请求执行此操作。"}
      </p>
      <div className="proposal-actions">
        <input
          className="fw-feedback-input"
          placeholder="拒绝理由（可选，会反馈给 Agent）"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
        />
        <button type="button" className="command-button quiet" disabled={busy} onClick={() => onReply("reject", feedback || undefined)}>
          拒绝
        </button>
        <button type="button" className="command-button quiet" disabled={busy} onClick={() => onReply("always")}>
          始终允许
        </button>
        <button type="button" className="command-button" disabled={busy} onClick={() => onReply("once")}>
          允许一次
        </button>
      </div>
    </article>
  );
}

function metadataCount(part: ToolPart): number | null {
  if (part.state.status !== "completed") return null;
  const value = part.state.metadata?.completed;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function assignToolsToTodos(todos: TodoItem[], tools: ToolPart[]): ToolPart[][] {
  const branches = todos.map(() => [] as ToolPart[]);
  let branchIndex = 0;
  for (const tool of tools) {
    if (tool.tool === "todo") {
      const completed = metadataCount(tool);
      if (completed !== null) branchIndex = Math.min(Math.max(completed, 0), todos.length - 1);
      continue;
    }
    branches[branchIndex]?.push(tool);
  }
  return branches;
}

function TaskPlanNode({ todo, index, tools }: { todo: TodoItem; index: number; tools: ToolPart[] }) {
  const [expanded, setExpanded] = useState(false);
  const active = todo.status === "in_progress";
  const canExpand = tools.length > 0;
  const open = canExpand && (active || expanded);
  const state = active ? "当前执行" : todo.status === "completed" ? "已完成" : todo.status === "cancelled" ? "已跳过" : "待执行";
  return (
    <li className={`fw-task-node ${todo.status}`}>
      <button type="button" className="fw-task-node-trigger" aria-expanded={open} disabled={!canExpand} onClick={() => setExpanded((value) => !value)}>
        <span className="fw-task-node-marker" aria-hidden>{todo.status === "completed" ? <Icon name="check" size={10} /> : active ? <span className="fw-todo-spinner" /> : null}</span>
        <span className="fw-task-node-copy"><span className="fw-task-node-index">{String(index + 1).padStart(2, "0")}</span><strong>{todo.content}</strong></span>
        <span className="fw-task-node-state">{canExpand ? `${tools.length} 次执行` : state}</span>
        {canExpand && <Icon name="chevron-down" size={12} className={open ? "fw-chevron open" : "fw-chevron"} />}
      </button>
      {open && tools.length > 0 && <div className="fw-task-executions">{tools.map((tool) => <ToolPartCard key={`${tool.id}:${tool.state.status}`} part={tool} />)}</div>}
    </li>
  );
}

export function TodoChecklist({ todos, tools }: { todos: TodoItem[]; tools: ToolPart[] }) {
  if (!todos.length) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  const current = todos.find((todo) => todo.status === "in_progress");
  const progress = Math.round((done / todos.length) * 100);
  const branches = assignToolsToTodos(todos, tools);
  return (
    <section className="fw-todo">
      <div className="fw-todo-head">
        <div className="fw-todo-heading"><span className="fw-todo-kicker">Task Plan</span><strong>{current ? "执行中" : done === todos.length ? "已完成" : "待执行"}</strong></div>
        <span className="fw-todo-progress"><b>{done}</b>/{todos.length}</span>
      </div>
      <div className="fw-todo-summary"><span>{current?.content ?? (done === todos.length ? "所有步骤已完成" : "等待 Agent 开始执行")}</span><span>{progress}%</span></div>
      <div className="fw-todo-progressbar" aria-hidden><span style={{ width: `${progress}%` }} /></div>
      <ol className="fw-todo-list">
        {todos.map((todo, index) => (
          <TaskPlanNode key={`${todo.content}-${index}`} todo={todo} index={index} tools={branches[index] ?? []} />
        ))}
      </ol>
    </section>
  );
}

export function ArtifactPreviewCard({ artifact, onOpen }: { artifact: ArtifactCard; onOpen: (artifact: ArtifactCard) => void }) {
  return (
    <button type="button" className="fw-artifact-card" onClick={() => onOpen(artifact)}>
      <span className="fw-artifact-name">{artifact.path}</span>
      <span className="fw-artifact-meta">
        {artifact.contentType.split("/").pop()} · {formatBytes(artifact.bytes)}
      </span>
      <span className="fw-artifact-actions">
        {artifact.previewUrl && <span className="fw-artifact-preview-hint">预览</span>}
        {artifact.downloadUrl && (
          <a className="fw-artifact-download" href={artifact.downloadUrl} onClick={(event) => event.stopPropagation()}>
            <Icon name="download" size={12} />
          </a>
        )}
      </span>
    </button>
  );
}

export function EditCard({ edit }: { edit: FileEdit }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fw-edit-card">
      <button type="button" className="fw-edit-head" onClick={() => setOpen((value) => !value)}>
        <Icon name="chevron-down" size={11} className={open ? "fw-chevron open" : "fw-chevron"} />
        <span className="fw-edit-path">{edit.path}</span>
        <small>{edit.revisionId.slice(0, 12)}</small>
      </button>
      {open && <DiffView diff={edit.diff} />}
    </div>
  );
}
