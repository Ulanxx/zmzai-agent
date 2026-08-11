import { publishFrameworkEvent } from "@/framework/core/events/bus";
import { FrameworkSessionModel } from "@/framework/core/session/mongo-models";

/** Framework lease recovery (spec §3.2): the runner stamps a lease on the
 *  session document while it owns a run. A periodic scan reclaims sessions
 *  whose lease lapsed without a live owner (process crash/restart), emitting
 *  a settle event so clients don't sit on a stale "running" status forever.
 *
 *  This complements the in-process activeRuns map — that map dies with the
 *  process, so recovery is driven purely from the persisted lease. */

const scanIntervalMs = 60_000;
const leaseDurationMs = 10 * 60 * 1000;

const globalRecovery = globalThis as typeof globalThis & { __zmzaiFrameworkLeaseTimer?: ReturnType<typeof setInterval> };

async function reclaimExpiredLeases(): Promise<void> {
  const expired = await FrameworkSessionModel.find({
    leaseExpiresAt: { $ne: null, $lt: new Date() },
  })
    .select({ sessionId: 1 })
    .limit(50)
    .lean();

  for (const session of expired) {
    const reclaimed = await FrameworkSessionModel.findOneAndUpdate(
      { sessionId: session.sessionId, leaseExpiresAt: { $ne: null, $lt: new Date() } },
      { $set: { leaseOwner: null, leaseExpiresAt: null } },
      { new: true },
    ).lean();
    if (!reclaimed) continue; // another scanner won the race
    await publishFrameworkEvent({
      sessionId: session.sessionId,
      type: "session.status",
      data: { status: "idle" },
    }).catch(() => undefined);
    await publishFrameworkEvent({
      sessionId: session.sessionId,
      type: "session.error",
      data: { name: "LeaseExpired", message: "运行因服务重启中断，可在同一会话继续。" },
    }).catch(() => undefined);
  }
}

export function startFrameworkLeaseRecovery(): void {
  if (globalRecovery.__zmzaiFrameworkLeaseTimer) return;
  globalRecovery.__zmzaiFrameworkLeaseTimer = setInterval(() => {
    void reclaimExpiredLeases().catch(() => undefined);
  }, scanIntervalMs);
  // Don't keep the process alive solely for the recovery timer.
  globalRecovery.__zmzaiFrameworkLeaseTimer.unref?.();
}

export { reclaimExpiredLeases, leaseDurationMs };
