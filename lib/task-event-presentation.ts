import type { AgentEvent } from "@earendil-works/pi-agent-core";

type PublicTaskEvent = { type: string; data: Record<string, unknown> };

const previewLimit = 4 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,}"\]]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization|api[_-]?key|token|cookie|password)\s*[:=]\s*[^\s,}"\]]+/gi, "$1: [REDACTED]");
}

function preview(value: string): { text: string; truncated: boolean; omittedBytes: number } {
  const clean = redact(value);
  const bytes = Buffer.byteLength(clean, "utf8");
  if (bytes <= previewLimit) return { text: clean, truncated: false, omittedBytes: 0 };
  let text = clean;
  while (Buffer.byteLength(text, "utf8") > previewLimit) text = text.slice(0, -1);
  return { text, truncated: true, omittedBytes: bytes - Buffer.byteLength(text, "utf8") };
}

function toolData(result: unknown): unknown {
  const output = record(result);
  const content = Array.isArray(output.content) ? output.content : [];
  const text = content.find((item) => record(item).type === "text");
  const textRecord = record(text);
  const raw = typeof textRecord.text === "string" ? textRecord.text : "";
  try { return record(JSON.parse(raw)).data; } catch { return undefined; }
}

function argsSummary(name: string, args: unknown): string {
  const value = record(args);
  if (typeof value.path === "string") return `${name} ${value.path}`;
  if (typeof value.query === "string") return `${name} “${preview(value.query).text}”`;
  return name;
}

function resultSummary(name: string, result: unknown, isError: boolean): { text: string; truncated: boolean; omittedBytes: number } {
  if (isError) {
    const value = record(result);
    const content = Array.isArray(value.content) ? value.content : [];
    const text = content.map((item) => typeof record(item).text === "string" ? record(item).text : "").join("\n");
    return preview(text || `${name} 执行失败`);
  }
  const value = toolData(result);
  if (name === "list" && Array.isArray(value)) return preview(`发现 ${value.length} 个文件`);
  const data = record(value);
  if (name === "read" && typeof data.path === "string" && typeof data.content === "string") return preview(`已读取 ${data.path} · ${Buffer.byteLength(data.content, "utf8")} B`);
  if (name === "search" && Array.isArray(data.matches)) return preview(`找到 ${data.matches.length} 个匹配`);
  if ((name === "write" || name === "edit") && typeof data.path === "string") return preview(`已暂存 ${data.path} 的变更`);
  return preview(`${name} 已完成`);
}

function artifactFor(name: string, toolCallId: string, result: unknown): PublicTaskEvent | null {
  const value = toolData(result);
  const data = record(value);
  if (name === "read" && typeof data.path === "string" && typeof data.content === "string") {
    const content = preview(data.content);
    return { type: "artifact.upsert", data: { artifactId: `artifact_${toolCallId}`, toolCallId, kind: "file_preview", title: data.path, payload: { path: data.path, content: content.text, truncated: content.truncated, omittedBytes: content.omittedBytes } } };
  }
  if (name === "search" && typeof data.query === "string" && Array.isArray(data.matches)) {
    const matches = data.matches.slice(0, 20).map((match) => {
      const item = record(match);
      return { path: typeof item.path === "string" ? item.path : "", line: typeof item.line === "number" ? item.line : 0, text: typeof item.text === "string" ? preview(item.text).text : "" };
    });
    return { type: "artifact.upsert", data: { artifactId: `artifact_${toolCallId}`, toolCallId, kind: "search_results", title: `搜索 “${preview(data.query).text}”`, payload: { query: preview(data.query).text, matches, truncated: data.matches.length > matches.length, omittedBytes: 0 } } };
  }
  return null;
}

export function presentAgentEvent(event: AgentEvent, startedAt: Map<string, number>, now = Date.now()): PublicTaskEvent[] {
  if (event.type === "message_start" && event.message.role === "assistant") return [{ type: "message.started", data: { messageId: String(event.message.timestamp) } }];
  if (event.type === "message_update" && event.message.role === "assistant" && event.assistantMessageEvent.type === "text_delta") return [{ type: "message.delta", data: { messageId: String(event.message.timestamp), delta: event.assistantMessageEvent.delta } }];
  if (event.type === "message_end" && event.message.role === "assistant") return [{ type: "message.completed", data: { messageId: String(event.message.timestamp) } }];
  if (event.type === "tool_execution_start") {
    startedAt.set(event.toolCallId, now);
    return [{ type: "tool.requested", data: { toolCallId: event.toolCallId, name: event.toolName, argsSummary: argsSummary(event.toolName, event.args) } }];
  }
  if (event.type === "tool_execution_update") return [{ type: "tool.progress", data: { toolCallId: event.toolCallId, name: event.toolName, label: "正在执行" } }];
  if (event.type === "tool_execution_end") {
    const durationMs = Math.max(0, now - (startedAt.get(event.toolCallId) ?? now));
    startedAt.delete(event.toolCallId);
    const summary = resultSummary(event.toolName, event.result, event.isError);
    const completed: PublicTaskEvent = { type: event.isError ? "tool.failed" : "tool.completed", data: { toolCallId: event.toolCallId, name: event.toolName, durationMs, resultSummary: summary } };
    const artifact = event.isError ? null : artifactFor(event.toolName, event.toolCallId, event.result);
    return artifact ? [completed, artifact] : [completed];
  }
  return [];
}
