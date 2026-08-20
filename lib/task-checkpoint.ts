import { randomUUID } from "node:crypto";

import type { PersistedFrameworkEvent } from "@zmzai/agent-framework";

import { CheckpointModel } from "@/models/checkpoint";
import { RunModel } from "@/models/run";

type CheckpointState = {
  eventType: PersistedFrameworkEvent["type"];
  eventSeq: number;
  at: string;
  boundary: "tool" | "step" | "artifact" | "approval" | "status" | "edit";
  summary: Record<string, unknown>;
};

export type CheckpointResumeSummary = {
  checkpointId: string;
  eventSeq: number;
  boundary: CheckpointState["boundary"];
  summary: Record<string, unknown>;
  completedStepIds: string[];
  completedToolCallIds: string[];
  artifactIds: string[];
};

export function buildCheckpointResumeContext(checkpoint: CheckpointResumeSummary | null): string {
  if (!checkpoint) return "\n没有可用的持久检查点，请先检查当前 Workspace 状态再执行。";
  return `\n恢复检查点 ${checkpoint.checkpointId}（事件 ${checkpoint.eventSeq}）：已完成步骤 ${checkpoint.completedStepIds.length} 个、已完成工具调用 ${checkpoint.completedToolCallIds.length} 个、已生成成果 ${checkpoint.artifactIds.length} 个。不要重复确认已完成的成果；先核对当前 Workspace 状态，再从未完成的动作继续。`;
}

const checkpointEvents = new Set<PersistedFrameworkEvent["type"]>([
  "session.status",
  "permission.replied",
  "message.part.updated",
  "todo.updated",
  "file.edited",
  "artifact.created",
]);

function checkpointBoundary(event: PersistedFrameworkEvent): CheckpointState["boundary"] | null {
  if (event.type === "session.status") return "status";
  if (event.type === "permission.replied") return "approval";
  if (event.type === "message.part.updated") {
    const status = event.data.part.type === "tool" ? event.data.part.state.status : null;
    return status === "pending" || status === "running" || status === "completed" || status === "error" ? "tool" : null;
  }
  if (event.type === "todo.updated") return "step";
  if (event.type === "file.edited") return "edit";
  if (event.type === "artifact.created") return "artifact";
  return null;
}

/** Builds a durable, non-sensitive summary. Tool inputs/results never enter
 * checkpoints because they may contain credentials, file contents, or tokens. */
export function checkpointSummary(event: PersistedFrameworkEvent): CheckpointState | null {
  if (!checkpointEvents.has(event.type)) return null;
  const boundary = checkpointBoundary(event);
  if (!boundary) return null;

  if (event.type === "session.status") return { eventType: event.type, eventSeq: event.seq, at: event.at, boundary, summary: { status: event.data.status } };
  if (event.type === "permission.replied") return { eventType: event.type, eventSeq: event.seq, at: event.at, boundary, summary: { requestId: event.data.id, reply: event.data.reply } };
  if (event.type === "todo.updated") {
    return {
      eventType: event.type,
      eventSeq: event.seq,
      at: event.at,
      boundary,
      summary: {
        total: event.data.todos.length,
        completed: event.data.todos.filter((todo) => todo.status === "completed").length,
        inProgress: event.data.todos.filter((todo) => todo.status === "in_progress").length,
      },
    };
  }
  if (event.type === "file.edited") return { eventType: event.type, eventSeq: event.seq, at: event.at, boundary, summary: { path: event.data.path, revisionId: event.data.revisionId } };
  if (event.type === "artifact.created") return { eventType: event.type, eventSeq: event.seq, at: event.at, boundary, summary: { artifactId: event.data.artifactId, path: event.data.path, bytes: event.data.bytes, contentType: event.data.contentType } };

  if (event.type !== "message.part.updated") return null;
  const part = event.data.part;
  if (part.type !== "tool") return null;
  return {
    eventType: event.type,
    eventSeq: event.seq,
    at: event.at,
    boundary,
    summary: { partId: part.id, callId: part.callId, tool: part.tool, status: part.state.status, title: "title" in part.state ? part.state.title : undefined },
  };
}

function appendUnique(values: string[], value: string | undefined): void {
  if (value && !values.includes(value)) values.push(value);
}

/** Persists a checkpoint before the EventLog caller publishes the event to
 * clients. It is deliberately best-effort: an unavailable projection must
 * not make the authoritative event stream disappear. */
export async function persistTaskCheckpoint(event: PersistedFrameworkEvent): Promise<void> {
  const summary = checkpointSummary(event);
  if (!summary) return;

  const run = await RunModel.findOne({ sessionId: event.sessionId }).sort({ createdAt: -1 }).lean();
  if (!run) return;
  const previous = await CheckpointModel.findOne({ runId: run.runId }).sort({ eventSeq: -1 }).lean();
  const checkpointId = `chk_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const completedToolCallIds = [...(previous?.completedToolCallIds ?? [])];
  const artifactIds = [...(previous?.artifactIds ?? [])];
  const completedStepIds = [...(previous?.completedStepIds ?? [])];
  const previousState = previous?.state as { summary?: Record<string, unknown> } | undefined;

  if (event.type === "message.part.updated" && event.data.part.type === "tool" && event.data.part.state.status === "completed") {
    appendUnique(completedToolCallIds, event.data.part.callId);
  }
  if (event.type === "artifact.created") appendUnique(artifactIds, event.data.artifactId);
  if (event.type === "todo.updated") {
    event.data.todos.forEach((todo, index) => {
      if (todo.status === "completed") appendUnique(completedStepIds, `todo:${index}`);
    });
  }

  try {
    await CheckpointModel.create({
      checkpointId,
      taskId: run.taskId,
      runId: run.runId,
      sessionId: event.sessionId,
      eventSeq: event.seq,
      state: { ...summary, summary: { ...(previousState?.summary ?? {}), ...summary.summary } },
      completedStepIds,
      completedToolCallIds,
      artifactIds,
      approvalGrantIds: previous?.approvalGrantIds ?? [],
    });
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || (error as { code?: unknown }).code !== 11000) throw error;
    return;
  }
  await RunModel.updateOne({ runId: run.runId }, { $set: { latestCheckpointId: checkpointId } });
}

export async function latestCheckpointForRun(input: { runId: string; userId: string }): Promise<CheckpointResumeSummary | null> {
  const run = await RunModel.findOne({ runId: input.runId, userId: input.userId }).select({ runId: 1 }).lean();
  if (!run) return null;
  const checkpoint = await CheckpointModel.findOne({ runId: input.runId }).sort({ eventSeq: -1 }).lean();
  if (!checkpoint) return null;
  return {
    checkpointId: checkpoint.checkpointId,
    eventSeq: checkpoint.eventSeq,
    boundary: (checkpoint.state as { boundary?: CheckpointState["boundary"] }).boundary ?? "status",
    summary: (checkpoint.state as { summary?: Record<string, unknown> }).summary ?? {},
    completedStepIds: checkpoint.completedStepIds,
    completedToolCallIds: checkpoint.completedToolCallIds,
    artifactIds: checkpoint.artifactIds,
  };
}
