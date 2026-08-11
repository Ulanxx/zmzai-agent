/** Product compatibility layer over the framework's EventLog interface (M5):
 *  the old `publishFrameworkEvent` / `subscribeFrameworkEvents` /
 *  `readFrameworkEvents` names are kept for the product's routes and
 *  lease-recovery, now backed by the Mongo EventLog implementation. */
import { mongoEventLog } from "@/framework/core/events/mongo-event-log";
import { subscribeEventLog, notifyEventLogListeners } from "@zmzai/agent-framework";
import type { FrameworkEvent, PersistedFrameworkEvent } from "@zmzai/agent-framework";

export async function publishFrameworkEvent(event: FrameworkEvent & { sessionId: string }): Promise<PersistedFrameworkEvent> {
  const persisted = await mongoEventLog.append(event);
  notifyEventLogListeners(persisted);
  return persisted;
}

export async function* subscribeFrameworkEvents(sessionId: string, options: { sinceSeq?: number; pollIntervalMs?: number; signal?: AbortSignal } = {}): AsyncIterable<PersistedFrameworkEvent> {
  yield* subscribeEventLog(mongoEventLog, sessionId, options);
}

export async function readFrameworkEvents(sessionId: string, sinceSeq = 0, limit = 1_000): Promise<PersistedFrameworkEvent[]> {
  return mongoEventLog.read(sessionId, sinceSeq, limit);
}
