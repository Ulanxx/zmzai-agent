import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { AutomationModel } from "@/models/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const updateSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), goal: z.string().trim().min(1).max(32 * 1024).optional(), schedule: z.string().trim().max(120).optional(), status: z.enum(["active", "paused"]).optional() }).strict();

export async function PATCH(request: NextRequest, context: { params: Promise<{ automationId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { automationId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "自动化更新请求格式不正确");
  const automation = await AutomationModel.findOneAndUpdate({ automationId, userId: user.id }, { $set: parsed.data }, { new: true }).lean();
  if (!automation) return apiError("AUTOMATION_NOT_FOUND", 404, "自动化不存在或无权访问");
  return NextResponse.json({ automation }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ automationId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { automationId } = await context.params;
  const deleted = await AutomationModel.deleteOne({ automationId, userId: user.id });
  if (!deleted.deletedCount) return apiError("AUTOMATION_NOT_FOUND", 404, "自动化不存在或无权访问");
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
