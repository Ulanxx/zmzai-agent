"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge, DiffView, Icon, Markdown, ToolGroup } from "@zmzai/theme";

import type { ArtifactCard, FileEdit, PermissionRequest, Reply, TodoItem } from "@/framework/client/use-framework-session";
import type { MessageWithParts, Part } from "@/framework/core/session/types";

// 业务组件（审批卡/Task Plan/工具卡/Markdown/DiffView）已下沉 @zmzai/theme 0.3.0；
// PermissionCard/TodoChecklist 此处 re-export 保持 workbench 的既有导入路径。
export { PermissionCard, TodoChecklist } from "@zmzai/theme";

/** Part renderers (spec §10.2): the conversation stream renders directly from
 *  the part list — text/reasoning/tool/step parts inline, approvals as inline
 *  cards, todos as a pinned checklist, artifacts as preview cards. */

/** Canvas 内的 pptx 预览：fetch previewUrl 原始字节，用 pptx-preview 渲染
 *  成可翻页的幻灯片（pptx 无法像 html/pdf 那样 iframe 内嵌）。 */
export function PptxPreview({ previewUrl }: { previewUrl: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let destroyed = false;
    let previewer: { preview: (buffer: ArrayBuffer) => Promise<unknown>; destroy: () => void } | null = null;
    (async () => {
      try {
        const response = await fetch(previewUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`预览加载失败（HTTP ${response.status}）`);
        const buffer = await response.arrayBuffer();
        if (destroyed || !containerRef.current) return;
        const { init } = await import("pptx-preview");
        previewer = init(containerRef.current, { width: 860, height: 484 });
        await previewer.preview(buffer);
      } catch (cause) {
        if (!destroyed) setError(cause instanceof Error ? cause.message : "PPT 预览失败");
      }
    })();
    return () => {
      destroyed = true;
      previewer?.destroy();
    };
  }, [previewUrl]);

  if (error) return <p className="p-4 text-center text-sm text-ink-3">{error}，可改用下载按钮。</p>;
  return <div ref={containerRef} className="pptx-preview-host p-3" />;
}


function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

type ToolPart = Extract<Part, { type: "tool" }>;

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
      <Badge variant="outline" size="sm">子任务</Badge>
    </div>
  );
}

export function MessageView({ entry: source, hideTools = false, sessionIdle = false }: { entry: MessageWithParts | MessageWithParts[]; hideTools?: boolean; sessionIdle?: boolean }) {
  const entries = Array.isArray(source) ? source : [source];
  const entry = entries[0];
  if (!entry) return null;
  if (entry.info.role === "user") {
    const text = entry.parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!text.trim()) return null;
    const created = new Date(entry.info.time.created);
    const timeLabel = Number.isNaN(created.getTime()) ? null : created.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return (
      <div className="fw-message user">
        <span className="fw-message-avatar">你</span>
        <div className="fw-message-column">
          <div className="fw-message-meta"><strong>你</strong>{timeLabel && <span>{timeLabel}</span>}</div>
          <div className="fw-message-content">{text}</div>
        </div>
      </div>
    );
  }
  const assistantEntries = entries.filter((item) => item.info.role === "assistant");
  const active = assistantEntries.some((item) => !("completed" in item.info.time) || !item.info.time.completed);
  const parts = entries.flatMap((item) => item.parts);
  const errorEntry = assistantEntries.find((item) => "error" in item.info && item.info.error);
  const error = errorEntry && "error" in errorEntry.info ? errorEntry.info.error : undefined;
  // 把连续的 tool parts 折叠为一组（G1）；其它 part 正常渲染。
  const rendered: ReactNode[] = [];
  let pendingTools: ToolPart[] = [];
  let keyCounter = 0;
  const flushTools = () => {
    if (!pendingTools.length) return;
    const group = pendingTools;
    pendingTools = [];
    // hideTools（todo 模式）下也显示折叠摘要——摘要是消息流的一部分，
    // 不展开工具卡。但若该组只有 1 个且是 todo 工具，整组跳过（todo 由
    // TodoChecklist 单独渲染，不重复）。
    if (hideTools && group.length === 1 && group[0]!.tool === "todo") return;
    rendered.push(<ToolGroup key={`toolgroup-${keyCounter++}`} calls={hideTools ? group.filter((t) => t.tool !== "todo") : group} sessionIdle={sessionIdle} />);
  };
  for (const part of parts) {
    if (part.type === "tool") {
      pendingTools.push(part);
      continue;
    }
    flushTools();
    switch (part.type) {
      case "text":
        rendered.push(<TextPart key={part.id} part={part} />);
        break;
      case "reasoning":
        rendered.push(<ReasoningPart key={part.id} part={part} active={active} />);
        break;
      case "subtask":
        rendered.push(<SubtaskPart key={part.id} part={part} />);
        break;
      default:
        break;
    }
  }
  flushTools();
  const firstCreated = assistantEntries[0]?.info.time.created;
  const timeLabel = firstCreated && !Number.isNaN(new Date(firstCreated).getTime())
    ? new Date(firstCreated).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div className="fw-message assistant">
      <span className="fw-message-avatar assistant">使</span>
      <div className="fw-message-column">
      <div className="fw-message-meta"><strong>ZMZAI Agent</strong><Badge variant={active ? "accent" : "success"} size="sm">{active ? "执行中" : "已完成"}</Badge>{timeLabel && <span className="fw-message-time">{timeLabel}</span>}</div>
      <div className="fw-execution-tree">{rendered}</div>
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

/** MIME → 卡片用的短类型名。完整 MIME（如 OOXML 的超长串）会撑坏
 *  卡片布局也不可读，映射为扩展名风格；未知长类型取 subtype 末段。 */
function shortContentType(contentType: string): string {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const known: Record<string, string> = {
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/pdf": "pdf",
    "application/json": "json",
    "application/zip": "zip",
    "text/html": "html",
    "text/markdown": "md",
    "text/plain": "txt",
    "text/css": "css",
  };
  if (known[type]) return known[type]!;
  const sub = type.split("/").pop() ?? "file";
  if (sub.length <= 14) return sub;
  const tail = sub.split(".").pop() ?? sub;
  return tail.length <= 14 ? tail : "file";
}

export function ArtifactPreviewCard({ artifact, onOpen }: { artifact: ArtifactCard; onOpen: (artifact: ArtifactCard) => void }) {
  return (
    <button type="button" className="fw-artifact-card" onClick={() => onOpen(artifact)}>
      <span className="fw-artifact-name">{artifact.path}</span>
      <span className="fw-artifact-meta">
        {shortContentType(artifact.contentType)} · {formatBytes(artifact.bytes)}
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
