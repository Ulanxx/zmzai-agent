import { timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getServerEnvironment } from "@/config/env";
import { apiError } from "@/lib/api-error";
import { dispatchDueWebhookDeliveries } from "@/lib/outbound-webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function matches(input: string | null, expected: string | undefined): boolean {
  if (!input || !expected) return false;
  const left = Buffer.from(input); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: NextRequest) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-automation-scheduler-secret");
  if (!matches(supplied, getServerEnvironment().AUTOMATION_SCHEDULER_SECRET)) return apiError("UNAUTHORIZED", 401, "未授权的投递请求");
  const body = await request.json().catch(() => ({})) as { limit?: unknown };
  const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), 50) : 20;
  return NextResponse.json(await dispatchDueWebhookDeliveries({ limit }), { headers: { "cache-control": "no-store" } });
}
