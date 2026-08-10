import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { listRunAudit, parseAuditListParams } from "@/lib/run-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const parsed = parseAuditListParams(request.nextUrl.searchParams);
  if (!parsed.ok) return apiError("INVALID_QUERY", 400, "审计筛选参数不正确");

  const result = await listRunAudit({ userId: user.id, params: parsed.value });
  if (result === null) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在");
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
