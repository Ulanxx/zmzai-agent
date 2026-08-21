import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-error";
import { getServerEnvironment } from "@/config/env";
import { reconcileRecentProjectUsage } from "@/lib/project-usage-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = getServerEnvironment().AUTOMATION_SCHEDULER_SECRET;
  if (!secret || request.headers.get("x-automation-scheduler-secret") !== secret) return apiError("UNAUTHORIZED", 401, "未授权的用量调度请求");
  return NextResponse.json(await reconcileRecentProjectUsage({ limit: 100 }), { headers: { "cache-control": "no-store" } });
}
