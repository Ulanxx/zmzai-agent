import { randomUUID } from "node:crypto";

import { ExecutionGrantModel, type ExecutionGrantRecord } from "@/models/execution-grant";

export const defaultGrantCommands = 20;
export const defaultGrantWallTimeMs = 10 * 60 * 1000;

export type ExecutionGrantView = {
  id: string;
  runId: string;
  workspaceId: string;
  sourceProposalId: string;
  createdAt: string;
  expiresAt: string;
  remainingCommands: number;
  remainingWallTimeMs: number;
  revokedAt: string | null;
};

function toView(grant: ExecutionGrantRecord): ExecutionGrantView {
  return {
    id: grant.grantId,
    runId: grant.runId,
    workspaceId: grant.workspaceId,
    sourceProposalId: grant.sourceProposalId,
    createdAt: grant.createdAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    remainingCommands: grant.remainingCommands,
    remainingWallTimeMs: grant.remainingWallTimeMs,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Creates the task-level execution grant after the user approves an exec
 * proposal ("批准并授权本任务执行").
 */
export async function createExecutionGrant(input: { userId: string; workspaceId: string; runId: string; sourceProposalId: string }): Promise<ExecutionGrantView | null> {
  const existing = await getActiveExecutionGrant({ userId: input.userId, runId: input.runId });
  if (existing) return existing;
  const grant = await ExecutionGrantModel.create({
    grantId: `grant_${randomUUID()}`,
    runId: input.runId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sourceProposalId: input.sourceProposalId,
    expiresAt: new Date(Date.now() + defaultGrantWallTimeMs),
    remainingCommands: defaultGrantCommands,
    remainingWallTimeMs: defaultGrantWallTimeMs,
    revokedAt: null,
  });
  return toView(grant);
}

/** Active grant = non-revoked, not expired, with remaining budget. */
export async function getActiveExecutionGrant(input: { userId: string; runId: string }): Promise<ExecutionGrantView | null> {
  const grant = await ExecutionGrantModel.findOne({ userId: input.userId, runId: input.runId, revokedAt: null }).sort({ createdAt: -1 }).lean();
  if (!grant) return null;
  if (grant.expiresAt.getTime() <= Date.now() || grant.remainingCommands <= 0 || grant.remainingWallTimeMs <= 0) return null;
  return toView(grant);
}

/** Decrements budget after a granted command runs. Returns the updated grant. */
export async function consumeExecutionGrant(input: { grantId: string; durationMs: number }): Promise<ExecutionGrantView | null> {
  const grant = await ExecutionGrantModel.findOneAndUpdate(
    { grantId: input.grantId, revokedAt: null, remainingCommands: { $gt: 0 } },
    { $inc: { remainingCommands: -1, remainingWallTimeMs: -Math.max(0, input.durationMs) } },
    { new: true },
  ).lean();
  return grant ? toView(grant) : null;
}

/** Revokes the active grant (task cancelled). Idempotent. */
export async function revokeExecutionGrant(runId: string): Promise<void> {
  await ExecutionGrantModel.updateMany({ runId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
