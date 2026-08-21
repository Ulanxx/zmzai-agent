"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ArtifactCard,
  EditCard as ThemeEditCard,
  formatBytes,
  Icon,
  Markdown,
  MessageItem,
  Reasoning,
  shortContentType,
  SubtaskPart,
  ToolCard,
  ToolGroup,
} from "@zmzai/theme";

import type { ArtifactCard as ArtifactCardData, FileEdit, MessageWithParts, Part } from "@/framework/client/use-framework-session";

// 业务组件（消息流/思考/工具卡/产物卡/改动卡/审批卡/Task Plan/Markdown/DiffView）
// 已全部下沉 @zmzai/theme 0.4.0；PermissionCard/TodoChecklist 此处 re-export
// 保持 workbench 的既有导入路径。
export { PermissionCard, TodoChecklist } from "@zmzai/theme";

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

type ToolPart = Extract<Part, { type: "tool" }>;

function TextPart({ part }: { part: Extract<Part, { type: "text" }> }) {
  return <div className="zmz-message-content"><Markdown text={part.text} /></div>;
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
      <MessageItem role="user" avatar="你" name="你" time={timeLabel}>
        <div className="zmz-message-content">{text}</div>
      </MessageItem>
    );
  }
  const assistantEntries = entries.filter((item) => item.info.role === "assistant");
  const active = assistantEntries.some((item) => !("completed" in item.info.time) || !item.info.time.completed);
  const parts = entries.flatMap((item) => item.parts);
  const errorEntry = assistantEntries.find((item) => "error" in item.info && item.info.error);
  const error = errorEntry && "error" in errorEntry.info ? errorEntry.info.error : undefined;
  const uncertainTool = parts.some((part) => part.type === "tool" && part.state.status === "error" && part.state.metadata?.outcome === "unknown");
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
        rendered.push(<Reasoning key={part.id} text={part.text} active={active} />);
        break;
      case "subtask":
        rendered.push(<SubtaskPart key={part.id} description={part.description} agent={part.agent} prompt={part.prompt} />);
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
    <MessageItem role="assistant" avatar="使" name="ZMZAI Agent" status={{ active }} time={timeLabel} noMotion>
      <div className="fw-execution-tree">{rendered}</div>
      {uncertainTool && <div className="run-unknown-note" role="alert">执行结果暂时无法确认，任务已暂停。请先确认外部动作是否已经生效，再发送消息继续。</div>}
      {error && <div className="run-note">出错了：{error.message}</div>}
    </MessageItem>
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

/** 产物卡适配器：agent 的 ArtifactCard 数据（GridFS 产物）→ theme ArtifactCard。 */
export function ArtifactPreviewCard({ artifact, onOpen }: { artifact: ArtifactCardData; onOpen: (artifact: ArtifactCardData) => void }) {
  return (
    <ArtifactCard
      path={artifact.path}
      meta={`${shortContentType(artifact.contentType)} · ${formatBytes(artifact.bytes)}`}
      previewHint={Boolean(artifact.previewUrl)}
      downloadUrl={artifact.downloadUrl}
      onOpen={() => onOpen(artifact)}
    />
  );
}

/** 改动卡适配器：agent 的 FileEdit → theme EditCard。 */
export function EditCard({ edit }: { edit: FileEdit }) {
  return <ThemeEditCard path={edit.path} revision={edit.revisionId} diff={edit.diff} />;
}
