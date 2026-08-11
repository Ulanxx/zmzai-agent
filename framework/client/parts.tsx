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

function ToolPartCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const state = part.state;
  const running = state.status === "running" || state.status === "pending";
  const title = state.status === "completed" ? state.title : state.status === "running" ? (state.title ?? part.tool) : part.tool;
  const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : null;
  const statusClass = state.status === "completed" ? "completed" : state.status === "error" ? "failed" : "running";

  return (
    <article className={`tool-card ${statusClass}`}>
      <div className="tool-card-head">
        <div className="tool-card-title">
          <span className={`tool-card-indicator ${statusClass}`} aria-hidden>
            {state.status === "completed" ? <Icon name="check" size={11} /> : state.status === "error" ? <Icon name="cross" size={11} /> : null}
          </span>
          <span className="tool-card-name">{part.tool}</span>
          <span className="tool-card-args">{title}</span>
        </div>
        <span className="tool-card-state">{running ? "执行中" : state.status === "error" ? "失败" : "完成"}</span>
      </div>
      {output !== null && (
        <>
          <div className="tool-card-actions">
            <button type="button" className="tool-card-open" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起" : "查看输出"}
            </button>
          </div>
          {expanded && <pre className="tool-card-detail">{output}</pre>}
        </>
      )}
    </article>
  );
}

function TextPart({ part }: { part: Extract<Part, { type: "text" }> }) {
  return (
    <article className="agent-message completed">
      <Markdown text={part.text} />
    </article>
  );
}

function ReasoningPart({ part }: { part: Extract<Part, { type: "reasoning" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fw-reasoning">
      <button type="button" className="fw-reasoning-toggle" onClick={() => setOpen((value) => !value)}>
        <Icon name="chevron-down" size={11} className={open ? "fw-chevron open" : "fw-chevron"} />
        思考过程
      </button>
      {open && <pre className="fw-reasoning-body">{part.text}</pre>}
    </div>
  );
}

export function MessageView({ entry }: { entry: MessageWithParts }) {
  if (entry.info.role === "user") {
    const text = entry.parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return (
      <article className="user-message">
        <span>你的任务</span>
        <p>{text || "（空消息）"}</p>
      </article>
    );
  }
  return (
    <div className="fw-assistant-turn">
      {entry.parts.map((part) => {
        switch (part.type) {
          case "text":
            return <TextPart key={part.id} part={part} />;
          case "reasoning":
            return <ReasoningPart key={part.id} part={part} />;
          case "tool":
            return <ToolPartCard key={part.id} part={part} />;
          case "step-start":
          case "step-finish":
            return null; // step boundaries are implicit in the stream
          default:
            return null;
        }
      })}
      {entry.info.error && <div className="run-note">出错了：{entry.info.error.message}</div>}
    </div>
  );
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

export function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <section className="fw-todo">
      <div className="fw-todo-head">
        <span>任务清单</span>
        <small>
          {done}/{todos.length}
        </small>
      </div>
      <ol className="fw-todo-list">
        {todos.map((todo, index) => (
          <li key={`${todo.content}-${index}`} className={`fw-todo-item ${todo.status}`}>
            <span className="fw-todo-marker" aria-hidden>
              {todo.status === "completed" ? <Icon name="check" size={10} /> : todo.status === "in_progress" ? <span className="fw-todo-spinner" /> : null}
            </span>
            <span className="fw-todo-content">{todo.content}</span>
          </li>
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
