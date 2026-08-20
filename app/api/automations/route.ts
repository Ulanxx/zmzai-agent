import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { getWorkspace } from "@/lib/workspaces";
import { AutomationModel } from "@/models/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ workspaceId: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(160), goal: z.string().trim().min(1).max(32 * 1024), schedule: z.string().trim().max(120).default("手动运行") }).strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  return NextResponse.json({ automations: await AutomationModel.find({ userId: user.id }).sort({ updatedAt: -1 }).lean() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "自动化请求格式不正确");
  if (!(await getWorkspace(user.id, parsed.data.workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  try {
    const claim = await claimIdempotency({ userId: user.id, scope: "automation.create", key: request.headers.get("idempotency-key"), body: parsed.data, resourceId: `aut_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
    if (claim.replayed) {
      const existing = await AutomationModel.findOne({ automationId: claim.resourceId, userId: user.id }).lean();
      if (existing) return NextResponse.json({ automation: existing, replayed: true }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    const automation = await AutomationModel.create({ automationId: claim.resourceId, userId: user.id, ...parsed.data });
    return NextResponse.json({ automation }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
