import { RunModel } from "@/models/run";
import { reconcileRunRelayUsage } from "@/lib/project-budget";

function currentPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Reconciles recent terminal Project runs after a worker restart or lost
 * framework terminal event. The per-run reconciliation record makes this
 * bounded scan safe to repeat from cron. */
export async function reconcileRecentProjectUsage(input: { limit?: number } = {}) {
  const runs = await RunModel.find({
    status: { $in: ["succeeded", "failed", "cancelled"] },
    finishedAt: { $gte: currentPeriodStart() },
  })
    .sort({ finishedAt: -1 })
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500))
    .select({ runId: 1 })
    .lean();
  let reconciled = 0;
  let deltaTokens = 0;
  for (const run of runs) {
    const result = await reconcileRunRelayUsage(run.runId).catch(() => ({ reconciled: false, deltaTokens: 0 }));
    if (result.reconciled) reconciled += 1;
    deltaTokens += result.deltaTokens;
  }
  return { scanned: runs.length, reconciled, deltaTokens };
}
