import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { getProjectBudget } from "@/lib/project-budget";
import { ProjectBudgetPolicyModel } from "@/models/project-budget-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ maxConcurrentRuns: z.number().int().min(1).max(32), monthlyTokenBudget: z.number().int().min(0).max(10_000_000_000) }).strict();

async function access(projectId: string, userId: string) { return getProjectAccess(projectId, userId); }

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser(); if (!user) return unauthenticated();
  const { projectId } = await context.params; const project = await access(projectId, user.id);
  if (!project) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  return NextResponse.json({ budget: await getProjectBudget(projectId, project.project.userId) }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser(); if (!user) return unauthenticated();
  const { projectId } = await context.params; const project = await access(projectId, user.id);
  if (!project || !canEditProject(project.role)) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权编辑");
  const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return apiError("INVALID_BODY", 400, "预算格式不正确");
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const existing = await ProjectBudgetPolicyModel.findOne({ projectId, userId: project.project.userId }).select({ usagePeriod: 1, usedTokens: 1 }).lean();
  const budget = await ProjectBudgetPolicyModel.findOneAndUpdate({ projectId, userId: project.project.userId }, { $set: { ...parsed.data, usagePeriod: currentPeriod, usedTokens: existing?.usagePeriod === currentPeriod ? existing.usedTokens : 0 }, $setOnInsert: { projectId, userId: project.project.userId, reservedRuns: 0 } }, { upsert: true, new: true }).lean();
  return NextResponse.json({ budget }, { headers: { "cache-control": "no-store" } });
}
