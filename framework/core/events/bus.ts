import { FrameworkEventModel, FrameworkSeqModel } from "@/framework/core/events/mongo-models";
import type { FrameworkEvent, FrameworkEventType, PersistedFrameworkEvent } from "@/framework/core/events/manifest";
import { frameworkEventSchemas } from "@/framework/core/events/manifest";
import { newEventId } from "@/framework/core/session/ids";

/** Event bus (spec §4.1). publish() validates against the manifest, allocates
 *  a per-session seq atomically, persists to fw_events (the replayable log),
 *  then fans out to in-memory subscribers. subscribe() merges live delivery
 *  with a Mongo catch-up poll so SSE clients can resume via sinceSeq. */

type LiveListener = (event: PersistedFrameworkEvent) => void;

const globalBus = globalThis as typeof globalThis & { __zmzaiFrameworkBusListeners?: Map<string, Set<LiveListener>> };
const listeners = globalBus.__zmzaiFrameworkBusListeners ?? new Map<string, Set<LiveListener>>();
globalBus.__zmzaiFrameworkBusListeners = listeners;

function notify(event: PersistedFrameworkEvent): void {
  for (const listener of listeners.get(event.sessionId) ?? []) {
    try {
      listener(event);
    } catch {
      // A throwing subscriber must never break the publish path.
    }
  }
}

export async function publishFrameworkEvent(event: FrameworkEvent & { sessionId: string }): Promise<PersistedFrameworkEvent> {
  const schema = frameworkEventSchemas[event.type as FrameworkEventType];
  const parsed = schema.safeParse(event.data);
  if (!parsed.success) throw new Error(`INVALID_FRAMEWORK_EVENT: ${event.type} ${parsed.error.issues[0]?.message ?? ""}`);

  const counter = await FrameworkSeqModel.findOneAndUpdate(
    { sessionId: event.sessionId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  ).lean();
  const persisted: PersistedFrameworkEvent = {
    ...event,
    data: parsed.data,
    id: newEventId(),
    seq: counter!.seq,
    at: new Date().toISOString(),
  } as PersistedFrameworkEvent;
  await FrameworkEventModel.create({
    eventId: persisted.id,
    sessionId: persisted.sessionId,
    seq: persisted.seq,
    type: persisted.type,
    data: persisted.data,
    at: new Date(persisted.at),
  });
  notify(persisted);
  return persisted;
}

export type SubscribeOptions = {
  sinceSeq?: number; // replay events with seq > sinceSeq before/live-merged
  pollIntervalMs?: number; // catch-up cadence for cross-process events
  signal?: AbortSignal;
};

export async function* subscribeFrameworkEvents(sessionId: string, options: SubscribeOptions = {}): AsyncIterable<PersistedFrameworkEvent> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  let cursor = options.sinceSeq ?? 0;
  const queue: PersistedFrameworkEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;

  const listener: LiveListener = (event) => {
    if (event.seq <= cursor) return;
    queue.push(event);
    wake?.();
  };
  const registered = listeners.get(sessionId) ?? new Set<LiveListener>();
  registered.add(listener);
  listeners.set(sessionId, registered);

  const onAbort = () => {
    done = true;
    wake?.();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!done) {
      // Catch-up poll: events published by other processes (or before this
      // subscription registered) are read from the durable log.
      const missed = await FrameworkEventModel.find({ sessionId, seq: { $gt: cursor } })
        .sort({ seq: 1 })
        .limit(500)
        .lean();
      for (const record of missed) {
        if (record.seq <= cursor) continue;
        queue.push({
          id: record.eventId,
          sessionId: record.sessionId,
          seq: record.seq,
          type: record.type,
          data: record.data,
          at: record.at.toISOString(),
        } as PersistedFrameworkEvent);
      }

      queue.sort((a, b) => a.seq - b.seq);
      while (queue.length && queue[0]!.seq > cursor) {
        const event = queue.shift()!;
        cursor = event.seq;
        yield event;
      }
      queue.length = 0;
      if (done) break;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, pollIntervalMs);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        if (done) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    registered.delete(listener);
    if (registered.size === 0) listeners.delete(sessionId);
  }
}

/** Reads the durable log directly (session restore / audit export). */
export async function readFrameworkEvents(sessionId: string, sinceSeq = 0, limit = 1_000): Promise<PersistedFrameworkEvent[]> {
  const records = await FrameworkEventModel.find({ sessionId, seq: { $gt: sinceSeq } })
    .sort({ seq: 1 })
    .limit(limit)
    .lean();
  return records.map(
    (record) =>
      ({
        id: record.eventId,
        sessionId: record.sessionId,
        seq: record.seq,
        type: record.type,
        data: record.data,
        at: record.at.toISOString(),
      }) as PersistedFrameworkEvent,
  );
}
