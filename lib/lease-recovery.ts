import { connectMongo } from "@/lib/database/mongodb";
import { appendTaskEvent } from "@/lib/task-events";
import { isAgentAlive } from "@/lib/agent-runtime";
import { revokeExecutionGrant } from "@/lib/execution-grants";
import { abortActiveExecution } from "@/lib/execution-resume";
import { cancelAgentSandboxRun } from "@/lib/sandbox-client";
import { ExecutionProposalModel } from "@/models/execution-proposal";
import { TaskRunModel } from "@/models/task-run";

// A waiting_approval run holds the workspace lock while the Agent waits for a
// decision. After a restart the Agent is gone, so an orphaned wait is only
// reclaimable after this grace period.
const waitingApprovalGraceMs = 5 * 60 * 1000;

const runtimeGlobal = globalThis as typeof globalThis & { __zmzaiLeaseRecoveryStarted?: boolean };

/**
 * Finds runs stuck in an active state whose execution lease has expired and
 * whose in-process Agent is gone (service crash/restart). Fails them safely,
 * releases the workspace lock and cascade-cancels any in-flight Sandbox runs,
 * so the workspace is never permanently blocked and no side effect repeats.
 */
export async function recoverExpiredLeases(now = Date.now()): Promise<{ recovered: number }> {
  await connectMongo();
  let recovered = 0;

  const expiredActive = await TaskRunModel.find({
    status: { $in: ["queued", "running"] },
    leaseExpiresAt: { $lt: new Date(now) },
    leaseOwner: { $ne: null },
  }).lean();

  for (const run of expiredActive) {
    if (isAgentAlive(run.runId)) continue; // alive in this process
    const updated = await TaskRunModel.updateOne(
      { runId: run.runId, status: { $in: ["queued", "running"] } },
      { $set: { status: "failed", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, failureCode: "LEASE_EXPIRED" }, $unset: { activeWorkspaceKey: 1 } },
    );
    if (updated.modifiedCount === 0) continue;
    await revokeExecutionGrant(run.runId);
    await appendTaskEvent({ runId: run.runId, userId: run.userId, type: "run.failed", data: { code: "LEASE_EXPIRED", error: "执行租约已过期（服务重启或崩溃），任务已安全终止；可在同一会话继续对话。" } });
    await cancelApprovedExecutions(run.runId, run.userId);
    recovered += 1;
  }

  const orphanedWaiting = await TaskRunModel.find({
    status: "waiting_approval",
    updatedAt: { $lt: new Date(now - waitingApprovalGraceMs) },
  }).lean();

  for (const run of orphanedWaiting) {
    if (isAgentAlive(run.runId)) continue; // still waiting with a live Agent
    const updated = await TaskRunModel.updateOne(
      { runId: run.runId, status: "waiting_approval" },
      { $set: { status: "failed", finishedAt: new Date(), failureCode: "LEASE_EXPIRED" }, $unset: { activeWorkspaceKey: 1 } },
    );
    if (updated.modifiedCount === 0) continue;
    await revokeExecutionGrant(run.runId);
    await appendTaskEvent({ runId: run.runId, userId: run.userId, type: "run.failed", data: { code: "LEASE_EXPIRED", error: "等待审批超时（运行上下文已丢失），任务已安全终止；可在同一会话继续对话。" } });
    await cancelApprovedExecutions(run.runId, run.userId);
    recovered += 1;
  }

  return { recovered };
}

async function cancelApprovedExecutions(runId: string, userId: string): Promise<void> {
  abortActiveExecution(runId);
  const executions = await ExecutionProposalModel.find({ runId, userId, status: "approved", sandboxRunId: { $ne: null } }).select({ sandboxRunId: 1 }).lean();
  await Promise.all(executions.map((proposal) => cancelAgentSandboxRun(proposal.sandboxRunId as string).catch(() => undefined)));
}

/**
 * Starts the periodic lease recovery scan. Idempotent per process. Runs in the
 * self-hosted long-lived deployment (single node); guarded so Vercel-style
 * per-request instances do not spawn duplicate timers beyond their own scope.
 */
export function startLeaseRecovery(intervalMs = 60_000): void {
  if (runtimeGlobal.__zmzaiLeaseRecoveryStarted) return;
  runtimeGlobal.__zmzaiLeaseRecoveryStarted = true;
  void recoverExpiredLeases().catch((error: unknown) => console.error("lease recovery initial scan failed", error));
  const timer = setInterval(() => {
    void recoverExpiredLeases().catch((error: unknown) => console.error("lease recovery scan failed", error));
  }, intervalMs);
  timer.unref?.();
}
