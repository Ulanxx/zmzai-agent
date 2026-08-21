import { NextRequest, NextResponse } from "next/server";

import { getFrameworkRunner } from "@/framework/server/context";
import { apiError } from "@/lib/api-error";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { findPublicTask } from "@/lib/public-task-access";
import { requireAgentApiKey } from "@/lib/public-api";
import { cancelRunForSession } from "@/lib/task-run-control";
import { RunModel } from "@/models/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const authorized = await requireAgentApiKey(request, "tasks:write");
  if ("response" in authorized) return authorized.response;
  const { taskId } = await context.params;
  const task = await findPublicTask(taskId, authorized.key);
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  let claim;
  try {
    claim = await claimIdempotency({ userId: authorized.key.id, scope: "public.task.cancel", key: request.headers.get("idempotency-key"), body: { taskId }, resourceId: taskId });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  const run = await RunModel.findOne({ taskId, active: true }).sort({ createdAt: -1 }).lean();
  if (!run) return NextResponse.json({ task_id: taskId, cancelled: false, replayed: claim.replayed }, { status: 202, headers: { "cache-control": "no-store" } });
  const cancelled = await cancelRunForSession(run.sessionId, "API 调用取消任务");
  await getFrameworkRunner().abort(run.sessionId);
  return NextResponse.json({ task_id: taskId, cancelled: Boolean(cancelled), run_id: run.runId, replayed: claim.replayed }, { status: 202, headers: { "cache-control": "no-store" } });
}
