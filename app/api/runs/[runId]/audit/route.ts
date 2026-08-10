import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getRunAuditDetail } from "@/lib/run-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { runId } = await context.params;
  const detail = await getRunAuditDetail(user.id, runId);
  if (!detail) return apiError("RUN_NOT_FOUND", 404, "Task Run 不存在");
  return NextResponse.json(detail, { headers: { "cache-control": "no-store" } });
}
