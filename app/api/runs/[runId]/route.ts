import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getTaskRun } from "@/lib/task-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { runId } = await context.params;
  const run = await getTaskRun(user.id, runId);
  if (!run) return apiError("RUN_NOT_FOUND", 404, "Task Run 不存在");
  return NextResponse.json({ run }, { headers: { "cache-control": "no-store" } });
}
