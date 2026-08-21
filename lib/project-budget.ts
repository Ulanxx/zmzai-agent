import { ProjectBudgetPolicyModel } from "@/models/project-budget-policy";
import { ProjectRelayUsageReconciliationModel } from "@/models/project-relay-usage-reconciliation";
import { ProjectUsageEventModel } from "@/models/project-usage-event";
import { WorkspaceBudgetPolicyModel } from "@/models/workspace-budget-policy";
import { WorkspaceUsageEventModel } from "@/models/workspace-usage-event";
import { WorkspaceRelayUsageReconciliationModel } from "@/models/workspace-relay-usage-reconciliation";
import { ProjectModel } from "@/models/project";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { getServerEnvironment } from "@/config/env";

function period(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }

function runUsagePeriod(run: { finishedAt?: Date | null; createdAt?: Date | null }): string {
  return period(run.finishedAt ?? run.createdAt ?? new Date());
}

export class ProjectBudgetExceededError extends Error {
  constructor(public readonly projectId: string) { super("PROJECT_BUDGET_EXCEEDED"); this.name = "ProjectBudgetExceededError"; }
}

export class WorkspaceBudgetExceededError extends Error {
  constructor(public readonly workspaceId: string) { super("WORKSPACE_BUDGET_EXCEEDED"); this.name = "WorkspaceBudgetExceededError"; }
}

export async function reserveWorkspaceRun(input: { workspaceId: string; userId: string }): Promise<void> {
  const ownerId = input.userId;
  const currentPeriod = period();
  const policy = await WorkspaceBudgetPolicyModel.findOneAndUpdate(
    { workspaceId: input.workspaceId, userId: ownerId },
    { $setOnInsert: { workspaceId: input.workspaceId, userId: ownerId, maxConcurrentRuns: 8, monthlyTokenBudget: 0, usedTokens: 0, usagePeriod: currentPeriod, reservedRuns: 0 } },
    { upsert: true, new: true },
  ).lean();
  if (policy.usagePeriod !== currentPeriod) {
    await WorkspaceBudgetPolicyModel.updateOne({ workspaceId: input.workspaceId, userId: ownerId }, { $set: { usagePeriod: currentPeriod, usedTokens: 0 } });
    policy.usedTokens = 0;
  }
  const reserved = await WorkspaceBudgetPolicyModel.findOneAndUpdate(
    { workspaceId: input.workspaceId, userId: ownerId, reservedRuns: { $lt: policy.maxConcurrentRuns }, $or: [{ monthlyTokenBudget: 0 }, { usedTokens: { $lt: policy.monthlyTokenBudget } }] },
    { $inc: { reservedRuns: 1 } },
    { new: true },
  ).lean();
  if (!reserved) throw new WorkspaceBudgetExceededError(input.workspaceId);
}

export async function releaseWorkspaceRun(input: { workspaceId: string; userId: string }): Promise<void> {
  const ownerId = input.userId;
  await WorkspaceBudgetPolicyModel.updateOne({ workspaceId: input.workspaceId, userId: ownerId, reservedRuns: { $gt: 0 } }, { $inc: { reservedRuns: -1 } });
}

export async function reserveProjectRun(input: { projectId: string; userId: string }): Promise<void> {
  const project = await ProjectModel.findOne({ projectId: input.projectId }).select({ userId: 1 }).lean();
  const ownerId = project?.userId ?? input.userId;
  const currentPeriod = period();
  const policy = await ProjectBudgetPolicyModel.findOneAndUpdate(
    { projectId: input.projectId, userId: ownerId },
    { $setOnInsert: { projectId: input.projectId, userId: ownerId, maxConcurrentRuns: 4, monthlyTokenBudget: 0, usedTokens: 0, usagePeriod: currentPeriod, reservedRuns: 0 } },
    { upsert: true, new: true },
  ).lean();
  if (policy.usagePeriod !== currentPeriod) {
    await ProjectBudgetPolicyModel.updateOne({ projectId: input.projectId, userId: ownerId }, { $set: { usagePeriod: currentPeriod, usedTokens: 0 } });
    policy.usedTokens = 0;
    policy.usagePeriod = currentPeriod;
  }
  const reserved = await ProjectBudgetPolicyModel.findOneAndUpdate(
    {
      projectId: input.projectId,
      userId: ownerId,
      reservedRuns: { $lt: policy.maxConcurrentRuns },
      $or: [{ monthlyTokenBudget: 0 }, { usedTokens: { $lt: policy.monthlyTokenBudget } }],
    },
    { $inc: { reservedRuns: 1 } },
    { new: true },
  ).lean();
  if (!reserved) throw new ProjectBudgetExceededError(input.projectId);
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

/** Projects the final assistant usage event exactly once. The event id is the
 * framework event id, so replaying an event cannot inflate the project total. */
export async function recordProjectTokenUsage(input: {
  eventId: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): Promise<void> {
  const totalTokens = Math.max(0, input.inputTokens) + Math.max(0, input.outputTokens) + Math.max(0, input.cacheReadTokens ?? 0) + Math.max(0, input.cacheWriteTokens ?? 0);
  if (!totalTokens) return;
  const run = await RunModel.findOne({ sessionId: input.sessionId }).sort({ createdAt: -1 }).lean();
  if (!run) return;
  const task = await TaskModel.findOne({ taskId: run.taskId }).select({ projectId: 1, userId: 1 }).lean();
  if (!task) return;
  const workspaceOwnerId = task.userId;
  let workspaceRecorded = Boolean(run.workspaceId);
  try {
    if (!run.workspaceId) throw { code: "NO_WORKSPACE_ID" };
    await WorkspaceUsageEventModel.create({
      eventId: input.eventId,
      workspaceId: run.workspaceId,
      userId: workspaceOwnerId,
      taskId: run.taskId,
      runId: run.runId,
      sessionId: input.sessionId,
      inputTokens: Math.max(0, input.inputTokens),
      outputTokens: Math.max(0, input.outputTokens),
      cacheReadTokens: Math.max(0, input.cacheReadTokens ?? 0),
      cacheWriteTokens: Math.max(0, input.cacheWriteTokens ?? 0),
      totalTokens,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "NO_WORKSPACE_ID") workspaceRecorded = false;
    else if (!isDuplicateKey(error)) throw error;
    else workspaceRecorded = false;
  }
  if (workspaceRecorded) {
    const workspacePeriod = period();
    const workspacePolicy = await WorkspaceBudgetPolicyModel.findOneAndUpdate(
      { workspaceId: run.workspaceId, userId: workspaceOwnerId },
      { $setOnInsert: { workspaceId: run.workspaceId, userId: workspaceOwnerId, maxConcurrentRuns: 8, monthlyTokenBudget: 0, usedTokens: 0, usagePeriod: workspacePeriod, reservedRuns: 0 } },
      { upsert: true, new: true },
    ).lean();
    if (workspacePolicy.usagePeriod !== workspacePeriod) await WorkspaceBudgetPolicyModel.updateOne({ workspaceId: run.workspaceId, userId: workspaceOwnerId }, { $set: { usagePeriod: workspacePeriod, usedTokens: totalTokens } });
    else await WorkspaceBudgetPolicyModel.updateOne({ workspaceId: run.workspaceId, userId: workspaceOwnerId }, { $inc: { usedTokens: totalTokens } });
  }

  if (!task.projectId) return;
  const project = await ProjectModel.findOne({ projectId: task.projectId }).select({ userId: 1 }).lean();
  const ownerId = project?.userId ?? task.userId;
  try {
    await ProjectUsageEventModel.create({
      eventId: input.eventId,
      projectId: task.projectId,
      userId: ownerId,
      taskId: run.taskId,
      runId: run.runId,
      sessionId: input.sessionId,
      inputTokens: Math.max(0, input.inputTokens),
      outputTokens: Math.max(0, input.outputTokens),
      cacheReadTokens: Math.max(0, input.cacheReadTokens ?? 0),
      cacheWriteTokens: Math.max(0, input.cacheWriteTokens ?? 0),
      totalTokens,
    });
  } catch (error) {
    if (isDuplicateKey(error)) return;
    throw error;
  }
  const projectPeriod = period();
  const policy = await ProjectBudgetPolicyModel.findOneAndUpdate(
    { projectId: task.projectId, userId: ownerId },
    { $setOnInsert: { projectId: task.projectId, userId: ownerId, maxConcurrentRuns: 4, monthlyTokenBudget: 0, usedTokens: 0, usagePeriod: projectPeriod, reservedRuns: 0 } },
    { upsert: true, new: true },
  ).lean();
  if (policy.usagePeriod !== projectPeriod) {
    await ProjectBudgetPolicyModel.updateOne({ projectId: task.projectId, userId: ownerId }, { $set: { usagePeriod: projectPeriod, usedTokens: totalTokens } });
    return;
  }
  await ProjectBudgetPolicyModel.updateOne({ projectId: task.projectId, userId: ownerId }, { $inc: { usedTokens: totalTokens } });
}

export async function releaseProjectRun(input: { projectId: string; userId: string }): Promise<void> {
  const project = await ProjectModel.findOne({ projectId: input.projectId }).select({ userId: 1 }).lean();
  await ProjectBudgetPolicyModel.updateOne({ projectId: input.projectId, userId: project?.userId ?? input.userId, reservedRuns: { $gt: 0 } }, { $inc: { reservedRuns: -1 } });
}

export async function getProjectBudget(projectId: string, userId: string) {
  const policy = await ProjectBudgetPolicyModel.findOne({ projectId, userId }).lean();
  const currentPeriod = period();
  if (policy && policy.usagePeriod !== currentPeriod) {
    await ProjectBudgetPolicyModel.updateOne({ projectId, userId }, { $set: { usagePeriod: currentPeriod, usedTokens: 0 } });
    return { ...policy, usagePeriod: currentPeriod, usedTokens: 0 };
  }
  return policy ?? { projectId, userId, maxConcurrentRuns: 4, monthlyTokenBudget: 0, usedTokens: 0, usagePeriod: currentPeriod, reservedRuns: 0 };
}

export async function getWorkspaceBudget(workspaceId: string, userId: string) {
  const policy = await WorkspaceBudgetPolicyModel.findOneAndUpdate(
    { workspaceId, userId },
    { $setOnInsert: { workspaceId, userId, maxConcurrentRuns: 8, monthlyTokenBudget: 0, usedTokens: 0, usagePeriod: period(), reservedRuns: 0 } },
    { upsert: true, new: true },
  ).lean();
  const currentPeriod = period();
  if (policy.usagePeriod !== currentPeriod) {
    await WorkspaceBudgetPolicyModel.updateOne({ workspaceId, userId }, { $set: { usagePeriod: currentPeriod, usedTokens: 0 } });
    return { ...policy, usagePeriod: currentPeriod, usedTokens: 0 };
  }
  return policy;
}

type RelayUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

async function settledRelayUsage(runId: string): Promise<{ usageCount: number; totals: RelayUsageTotals } | null> {
  const environment = getServerEnvironment();
  const secret = environment.RELAY_AGENT_SERVICE_SECRET_CURRENT;
  if (!secret) return null;
  let response: Response;
  try {
    response = await fetch(`${environment.RELAY_AGENT_URL.replace(/\/$/, "")}/api/internal/agent/usages?taskRunId=${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { usageCount?: unknown; totals?: Partial<RelayUsageTotals> } | null;
  if (!body?.totals) return null;
  return {
    usageCount: nonNegative(body.usageCount),
    totals: {
      inputTokens: nonNegative(body.totals.inputTokens),
      outputTokens: nonNegative(body.totals.outputTokens),
      cacheReadTokens: nonNegative(body.totals.cacheReadTokens),
      cacheWriteTokens: nonNegative(body.totals.cacheWriteTokens),
      totalTokens: nonNegative(body.totals.totalTokens),
    },
  };
}

/**
 * Reconciles the immediate framework-event projection with Relay's settled
 * ledger. The correction is stored by run id, therefore a terminal event can
 * be replayed and this function can be retried without changing the budget
 * twice. A missing Relay record is normal for locally failed calls.
 */
export async function reconcileProjectRelayUsage(runId: string): Promise<{ reconciled: boolean; deltaTokens: number }> {
  const run = await RunModel.findOne({ runId }).lean();
  if (!run) return { reconciled: false, deltaTokens: 0 };
  if (runUsagePeriod(run) !== period()) return { reconciled: false, deltaTokens: 0 };
  const task = await TaskModel.findOne({ taskId: run.taskId }).select({ projectId: 1, userId: 1 }).lean();
  if (!task?.projectId) return { reconciled: false, deltaTokens: 0 };
  const settled = await settledRelayUsage(runId);
  if (!settled) return { reconciled: false, deltaTokens: 0 };
  const relay = settled.totals;

  const projected = await ProjectUsageEventModel.aggregate<{ totalTokens: number }>([
    { $match: { runId } },
    { $group: { _id: null, totalTokens: { $sum: "$totalTokens" } } },
  ]).then((rows) => nonNegative(rows[0]?.totalTokens));
  // Relay may still be settling the final streaming Usage document while the
  // framework has already reached idle. Never erase a visible projection just
  // because the authoritative ledger is a few milliseconds behind.
  if (relay.totalTokens === 0 && projected > 0 && settled.usageCount !== 0) return { reconciled: false, deltaTokens: 0 };
  const project = await ProjectModel.findOne({ projectId: task.projectId }).select({ userId: 1 }).lean();
  const ownerId = project?.userId ?? task.userId;
  const currentPeriod = period();
  const policy = await getProjectBudget(task.projectId, ownerId);
  const prior = await ProjectRelayUsageReconciliationModel.findOne({ runId }).lean();
  const priorDelta = prior?.usagePeriod === currentPeriod ? prior.appliedDeltaTokens : 0;
  const desiredDelta = relay.totalTokens - projected;
  const requestedDelta = desiredDelta - priorDelta;
  const nextUsed = Math.max(0, policy.usedTokens + requestedDelta);
  const appliedDelta = nextUsed - policy.usedTokens;

  if (appliedDelta) {
    await ProjectBudgetPolicyModel.updateOne(
      { projectId: task.projectId, userId: ownerId },
      { $set: { usedTokens: nextUsed, usagePeriod: currentPeriod } },
      { upsert: true },
    );
  }
  await ProjectRelayUsageReconciliationModel.findOneAndUpdate(
    { runId },
    {
      $set: {
        usagePeriod: currentPeriod,
        relayInputTokens: relay.inputTokens,
        relayOutputTokens: relay.outputTokens,
        relayCacheReadTokens: relay.cacheReadTokens,
        relayCacheWriteTokens: relay.cacheWriteTokens,
        relayTotalTokens: relay.totalTokens,
        projectedTotalTokens: projected,
        appliedDeltaTokens: priorDelta + appliedDelta,
        syncedAt: new Date(),
      },
      $setOnInsert: { projectId: task.projectId, userId: ownerId },
    },
    { upsert: true },
  );
  return { reconciled: true, deltaTokens: appliedDelta };
}

/** Reconciles Workspace usage for every Run, regardless of Project membership.
 * The same settled Relay ledger is used by the Project-specific correction. */
export async function reconcileWorkspaceRelayUsage(runId: string): Promise<{ reconciled: boolean; deltaTokens: number }> {
  const run = await RunModel.findOne({ runId }).lean();
  if (!run?.workspaceId) return { reconciled: false, deltaTokens: 0 };
  if (runUsagePeriod(run) !== period()) return { reconciled: false, deltaTokens: 0 };
  const task = await TaskModel.findOne({ taskId: run.taskId }).select({ userId: 1 }).lean();
  if (!task) return { reconciled: false, deltaTokens: 0 };
  const settled = await settledRelayUsage(runId);
  if (!settled) return { reconciled: false, deltaTokens: 0 };
  const relay = settled.totals;
  const projected = await WorkspaceUsageEventModel.aggregate<{ totalTokens: number }>([
    { $match: { runId } },
    { $group: { _id: null, totalTokens: { $sum: "$totalTokens" } } },
  ]).then((rows) => nonNegative(rows[0]?.totalTokens));
  if (relay.totalTokens === 0 && projected > 0 && settled.usageCount !== 0) return { reconciled: false, deltaTokens: 0 };

  const ownerId = task.userId;
  const currentPeriod = period();
  const policy = await getWorkspaceBudget(run.workspaceId, ownerId);
  const prior = await WorkspaceRelayUsageReconciliationModel.findOne({ runId }).lean();
  const priorDelta = prior?.usagePeriod === currentPeriod ? prior.appliedDeltaTokens : 0;
  const desiredDelta = relay.totalTokens - projected;
  const requestedDelta = desiredDelta - priorDelta;
  const nextUsed = Math.max(0, policy.usedTokens + requestedDelta);
  const appliedDelta = nextUsed - policy.usedTokens;
  if (appliedDelta) {
    await WorkspaceBudgetPolicyModel.updateOne(
      { workspaceId: run.workspaceId, userId: ownerId },
      { $set: { usedTokens: nextUsed, usagePeriod: currentPeriod } },
      { upsert: true },
    );
  }
  await WorkspaceRelayUsageReconciliationModel.findOneAndUpdate(
    { runId },
    {
      $set: {
        usagePeriod: currentPeriod,
        relayInputTokens: relay.inputTokens,
        relayOutputTokens: relay.outputTokens,
        relayCacheReadTokens: relay.cacheReadTokens,
        relayCacheWriteTokens: relay.cacheWriteTokens,
        relayTotalTokens: relay.totalTokens,
        projectedTotalTokens: projected,
        appliedDeltaTokens: priorDelta + appliedDelta,
        syncedAt: new Date(),
      },
      $setOnInsert: { workspaceId: run.workspaceId, userId: ownerId },
    },
    { upsert: true },
  );
  return { reconciled: true, deltaTokens: appliedDelta };
}

export async function reconcileRunRelayUsage(runId: string): Promise<{ reconciled: boolean; deltaTokens: number }> {
  const [workspace, project] = await Promise.all([
    reconcileWorkspaceRelayUsage(runId),
    reconcileProjectRelayUsage(runId),
  ]);
  return { reconciled: workspace.reconciled || project.reconciled, deltaTokens: workspace.deltaTokens + project.deltaTokens };
}
