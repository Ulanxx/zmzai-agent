import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";

import { ArtifactReferenceModel } from "@/models/artifact-reference";
import { TaskEventModel } from "@/models/task-event";
import { TaskRunModel } from "@/models/task-run";
import { ToolCallModel } from "@/models/tool-call";

export type PersistedTaskEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  at: string;
  data: unknown;
};

export class EventBudgetError extends Error {
  constructor() {
    super("EVENT_BUDGET_EXCEEDED");
    this.name = "EventBudgetError";
  }
}

function objectData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function summaryData(value: unknown): { text: string; truncated: boolean; omittedBytes: number } | null {
  const data = objectData(value);
  if (typeof data.text !== "string") return null;
  return {
    text: data.text.slice(0, 4 * 1024),
    truncated: data.truncated === true,
    omittedBytes: typeof data.omittedBytes === "number" ? data.omittedBytes : 0,
  };
}

async function projectToolCall(input: { runId: string; userId: string; type: string; data: unknown; at: Date; session?: ClientSession }): Promise<void> {
  const data = objectData(input.data);
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : null;
  if (!toolCallId) return;
  const name = typeof data.name === "string" ? data.name : "tool";

  if (input.type === "tool.requested") {
    await ToolCallModel.updateOne(
      { runId: input.runId, toolCallId },
      {
        $setOnInsert: {
          toolCallId,
          runId: input.runId,
          userId: input.userId,
          requestedAt: input.at,
        },
        $set: {
          name,
          status: "requested",
          argsSummary: typeof data.argsSummary === "string" ? data.argsSummary : name,
        },
      },
      { upsert: true, session: input.session },
    );
    return;
  }

  if (input.type === "tool.progress") {
    await ToolCallModel.updateOne(
      { toolCallId, runId: input.runId, userId: input.userId },
      { $set: { name, status: "running", label: typeof data.label === "string" ? data.label : "正在执行" } },
      { session: input.session },
    );
    return;
  }

  if (input.type === "tool.completed" || input.type === "tool.failed") {
    await ToolCallModel.updateOne(
      { toolCallId, runId: input.runId, userId: input.userId },
      {
        $set: {
          name,
          status: input.type === "tool.failed" ? "failed" : "completed",
          resultSummary: summaryData(data.resultSummary),
          durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
          completedAt: input.at,
        },
      },
      { session: input.session },
    );
  }
}

async function projectArtifact(input: { runId: string; userId: string; type: string; data: unknown; session?: ClientSession }): Promise<void> {
  const data = objectData(input.data);
  const artifactId = typeof data.artifactId === "string" ? data.artifactId : null;
  if (!artifactId) return;

  if (input.type === "artifact.upsert") {
    const payload = objectData(data.payload);
    await ArtifactReferenceModel.updateOne(
      { runId: input.runId, artifactId },
      {
        $setOnInsert: {
          artifactId,
          runId: input.runId,
          userId: input.userId,
          toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : null,
        },
        $set: {
          kind: typeof data.kind === "string" ? data.kind : "unknown",
          title: typeof data.title === "string" ? data.title : "运行上下文",
          payload,
          payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
          truncated: payload.truncated === true,
          omittedBytes: typeof payload.omittedBytes === "number" ? payload.omittedBytes : 0,
        },
      },
      { upsert: true, session: input.session },
    );
    return;
  }

  if (input.type === "artifact.append" && typeof data.text === "string") {
    const current = await ArtifactReferenceModel.findOne({ artifactId, runId: input.runId, userId: input.userId }).session(input.session ?? null);
    if (!current) return;
    const payload = objectData(current.payload);
    const content = `${typeof payload.content === "string" ? payload.content : ""}${data.text}`;
    const nextPayload = {
      ...payload,
      content,
      truncated: data.truncated === true || payload.truncated === true,
      omittedBytes: typeof data.omittedBytes === "number" ? data.omittedBytes : typeof payload.omittedBytes === "number" ? payload.omittedBytes : 0,
    };
    current.payload = nextPayload;
    current.payloadBytes = Buffer.byteLength(JSON.stringify(nextPayload), "utf8");
    current.truncated = nextPayload.truncated;
    current.omittedBytes = nextPayload.omittedBytes;
    await current.save({ session: input.session });
  }
}

async function projectTaskEvent(input: { runId: string; userId: string; type: string; data: unknown; at: Date; session?: ClientSession }): Promise<void> {
  if (input.type.startsWith("tool.")) await projectToolCall(input);
  if (input.type.startsWith("artifact.")) await projectArtifact(input);
}

// Terminal events must always be persistable, even when the run's event
// budget is exhausted (spec: 运行进入 failed 后必须保证 run.failed 可持久化
// 和推送，禁止静默丢弃). The counter may exceed the cap for these events.
const terminalEventTypes = new Set(["run.completed", "run.failed", "run.cancelled"]);

export async function appendTaskEvent(input: { runId: string; userId: string; type: string; data: unknown; session?: ClientSession }): Promise<PersistedTaskEvent> {
  const dataBytes = Buffer.byteLength(JSON.stringify(input.data), "utf8");
  const isTerminal = terminalEventTypes.has(input.type);
  const run = await TaskRunModel.findOneAndUpdate(
    isTerminal
      ? { runId: input.runId, userId: input.userId }
      : {
          runId: input.runId,
          userId: input.userId,
          $expr: { $lte: [{ $add: ["$persistedEventBytes", dataBytes] }, "$budget.maxPersistedEventBytes"] },
        },
    { $inc: { nextEventSequence: 1, persistedEventBytes: dataBytes } },
    { new: true },
  ).session(input.session ?? null).lean();
  if (!run) throw new EventBudgetError();

  const at = new Date();
  const [event] = await TaskEventModel.create([{
    eventId: `evt_${randomUUID()}`,
    runId: input.runId,
    sequence: run.nextEventSequence,
    type: input.type,
    data: input.data,
    at,
  }], { session: input.session });
  await projectTaskEvent({ runId: input.runId, userId: input.userId, type: input.type, data: input.data, at, session: input.session });
  return { id: event.eventId, runId: event.runId, sequence: event.sequence, type: event.type, at: event.at.toISOString(), data: event.data };
}

export async function listTaskEvents(runId: string, afterSequence: number): Promise<PersistedTaskEvent[]> {
  const events = await TaskEventModel.find({ runId, sequence: { $gt: afterSequence } }).sort({ sequence: 1 }).lean();
  return events.map((event) => ({
    id: event.eventId,
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
    at: event.at.toISOString(),
    data: event.data,
  }));
}
