import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";

import { TaskEventModel } from "@/models/task-event";
import { TaskRunModel } from "@/models/task-run";

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

export async function appendTaskEvent(input: { runId: string; userId: string; type: string; data: unknown; session?: ClientSession }): Promise<PersistedTaskEvent> {
  const dataBytes = Buffer.byteLength(JSON.stringify(input.data), "utf8");
  const run = await TaskRunModel.findOneAndUpdate(
    {
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
