import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { AutomationExecutionModel } from "@/models/automation-execution";
import { AutomationModel } from "@/models/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ automationId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { automationId } = await context.params;
  const automation = await AutomationModel.findOne({ automationId, userId: user.id }).select({ _id: 1 }).lean();
  if (!automation) return apiError("AUTOMATION_NOT_FOUND", 404, "自动化不存在或无权访问");
  const executions = await AutomationExecutionModel.find({ automationId, userId: user.id })
    .sort({ createdAt: -1 })
    .limit(20)
    .select({ executionId: 1, taskId: 1, runId: 1, source: 1, status: 1, error: 1, startedAt: 1, finishedAt: 1, createdAt: 1 })
    .lean();
  return NextResponse.json({ executions }, { headers: { "cache-control": "no-store" } });
}
