import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { WorkspaceBudgetPolicyModel } from "@/models/workspace-budget-policy";
import { WorkspaceModel } from "@/models/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({ maxConcurrentRuns: z.number().int().min(1).max(64), monthlyTokenBudget: z.number().int().min(0).max(1_000_000_000) }).strict();

function period(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }

async function readWorkspace(userId: string, workspaceId: string) {
  const workspace = await WorkspaceModel.findOne({ workspaceId, userId }).select({ workspaceId: 1, userId: 1 }).lean();
  if (!workspace) return null;
  const currentPeriod = period();
  const budget = await WorkspaceBudgetPolicyModel.findOneAndUpdate(
    { workspaceId, userId },
    { $setOnInsert: { workspaceId, userId, maxConcurrentRuns: 8, monthlyTokenBudget: 0, usedTokens: 0, usagePeriod: currentPeriod, reservedRuns: 0 } },
    { upsert: true, new: true },
  ).lean();
  if (budget.usagePeriod !== currentPeriod) {
    await WorkspaceBudgetPolicyModel.updateOne({ workspaceId, userId }, { $set: { usagePeriod: currentPeriod, usedTokens: 0 } });
    return { ...budget, usagePeriod: currentPeriod, usedTokens: 0 };
  }
  return budget;
}

export async function GET(_: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  const budget = await readWorkspace(user.id, workspaceId);
  if (!budget) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  return NextResponse.json({ budget }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Workspace 预算格式不正确");
  const workspace = await WorkspaceModel.findOne({ workspaceId, userId: user.id }).select({ workspaceId: 1 }).lean();
  if (!workspace) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  const existing = await readWorkspace(user.id, workspaceId);
  if (!existing) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  const budget = await WorkspaceBudgetPolicyModel.findOneAndUpdate({ workspaceId, userId: user.id }, { $set: { ...parsed.data, usagePeriod: period(), usedTokens: existing.usagePeriod === period() ? existing.usedTokens : 0 } }, { new: true }).lean();
  return NextResponse.json({ budget }, { headers: { "cache-control": "no-store" } });
}
