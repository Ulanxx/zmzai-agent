export type TaskEvent = { id: string; sequence: number; type: string; at: string; data: Record<string, unknown> };
export type ToolNode = { id: string; name: string; argsSummary: string; label: string; status: "requested" | "running" | "completed" | "failed"; durationMs: number | null; resultSummary: { text: string; truncated: boolean; omittedBytes: number } | null };
export type AssistantNode = { id: string; text: string; completed: boolean };
export type CanvasArtifact = { id: string; toolCallId: string | null; kind: string; title: string; payload: Record<string, unknown> };
export type TranscriptEntry = { kind: "tool" | "message"; id: string };
export type TaskProjection = { tools: ToolNode[]; messages: AssistantNode[]; artifacts: CanvasArtifact[]; transcript: TranscriptEntry[] };

function dataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function summary(value: unknown): ToolNode["resultSummary"] {
  const data = dataRecord(value);
  if (typeof data.text !== "string") return null;
  return { text: data.text, truncated: data.truncated === true, omittedBytes: typeof data.omittedBytes === "number" ? data.omittedBytes : 0 };
}

export function projectTaskEvents(events: TaskEvent[]): TaskProjection {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const tools = new Map<string, ToolNode>();
  const messages = new Map<string, AssistantNode>();
  const artifacts = new Map<string, CanvasArtifact>();
  const transcript: TranscriptEntry[] = [];
  for (const event of ordered) {
    const data = event.data ?? {};
    if (event.type === "message.started") {
      const id = typeof data.messageId === "string" ? data.messageId : "legacy";
      if (!messages.has(id)) { messages.set(id, { id, text: "", completed: false }); transcript.push({ kind: "message", id }); }
    }
    if (event.type === "message.delta") {
      const id = typeof data.messageId === "string" ? data.messageId : "legacy";
      const existing = messages.get(id);
      const current = existing ?? { id, text: "", completed: false };
      current.text += typeof data.delta === "string" ? data.delta : "";
      messages.set(id, current);
      if (!existing) transcript.push({ kind: "message", id });
    }
    if (event.type === "message.completed") {
      const id = typeof data.messageId === "string" ? data.messageId : "legacy";
      const existing = messages.get(id);
      const current = existing ?? { id, text: "", completed: false };
      current.completed = true;
      messages.set(id, current);
      if (!existing) transcript.push({ kind: "message", id });
    }
    if (event.type === "tool.requested") {
      const id = typeof data.toolCallId === "string" ? data.toolCallId : `tool_${event.sequence}`;
      if (!tools.has(id)) transcript.push({ kind: "tool", id });
      tools.set(id, { id, name: typeof data.name === "string" ? data.name : "tool", argsSummary: typeof data.argsSummary === "string" ? data.argsSummary : typeof data.name === "string" ? data.name : "tool", label: "等待执行", status: "requested", durationMs: null, resultSummary: null });
    }
    if (event.type === "tool.progress" || event.type === "tool.completed" || event.type === "tool.failed") {
      const id = typeof data.toolCallId === "string" ? data.toolCallId : `tool_${event.sequence}`;
      const existing = tools.get(id);
      const current = existing ?? { id, name: typeof data.name === "string" ? data.name : "tool", argsSummary: typeof data.name === "string" ? data.name : "tool", label: "", status: "requested" as const, durationMs: null, resultSummary: null };
      if (event.type === "tool.progress") { current.status = "running"; current.label = typeof data.label === "string" ? data.label : "正在执行"; }
      else { current.status = event.type === "tool.failed" ? "failed" : "completed"; current.label = current.status === "failed" ? "执行失败" : "已完成"; current.durationMs = typeof data.durationMs === "number" ? data.durationMs : null; current.resultSummary = summary(data.resultSummary); }
      tools.set(id, current);
      if (!existing) transcript.push({ kind: "tool", id });
    }
    if (event.type === "artifact.upsert") {
      const id = typeof data.artifactId === "string" ? data.artifactId : `artifact_${event.sequence}`;
      artifacts.set(id, { id, toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : null, kind: typeof data.kind === "string" ? data.kind : "unknown", title: typeof data.title === "string" ? data.title : "运行上下文", payload: dataRecord(data.payload) });
    }
    if (event.type === "artifact.append" && typeof data.artifactId === "string") {
      const current = artifacts.get(data.artifactId);
      if (current && typeof data.text === "string") current.payload = { ...current.payload, content: `${typeof current.payload.content === "string" ? current.payload.content : ""}${data.text}`, truncated: data.truncated === true || current.payload.truncated === true, omittedBytes: typeof data.omittedBytes === "number" ? data.omittedBytes : current.payload.omittedBytes ?? 0 };
    }
  }
  return { tools: [...tools.values()], messages: [...messages.values()], artifacts: [...artifacts.values()], transcript };
}
