import { timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getServerEnvironment } from "@/config/env";
import { connectMongo } from "@/lib/database/mongodb";
import { dispatchDueAutomations, schedulerOwner } from "@/lib/automation-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretMatches(input: string | null, expected: string | undefined): boolean {
  if (!input || !expected) return false;
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: NextRequest) {
  const environment = getServerEnvironment();
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-automation-scheduler-secret");
  if (!secretMatches(supplied, environment.AUTOMATION_SCHEDULER_SECRET)) return NextResponse.json({ error: "未授权的调度请求" }, { status: 401 });
  await connectMongo();
  const body = await request.json().catch(() => ({})) as { limit?: unknown };
  const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), 50) : 10;
  const result = await dispatchDueAutomations({ owner: schedulerOwner(), limit });
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
