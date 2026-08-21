import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-error";
import { dispatchDueWideResearch } from "@/lib/wide-research";
import { getServerEnvironment } from "@/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = getServerEnvironment().AUTOMATION_SCHEDULER_SECRET;
  if (!secret || request.headers.get("x-automation-scheduler-secret") !== secret) return apiError("UNAUTHORIZED", 401, "未授权的研究调度请求");
  return NextResponse.json(await dispatchDueWideResearch({ limit: 4 }), { headers: { "cache-control": "no-store" } });
}
