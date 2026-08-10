import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { ContinuationError, buildContinuationMessages, prepareContinuation } from "@/lib/continuation-context";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { runAgentTask } from "@/lib/agent-runtime";
import { createTaskRun, getTaskRun, listWorkspaceTaskRuns } from "@/lib/task-runs";
import { getWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createRunSchema = z.object({
  mode: z.enum(["plan", "build"]),
  model: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(32 * 1024),
  // Continuation: resume the conversation of a terminal run in the same session.
  continueFromRunId: z.string().trim().min(1).max(64).optional(),
}).strict();

export async function GET(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  if (!(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在");
  const limit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "30", 10);
  return NextResponse.json({ runs: await listWorkspaceTaskRuns(user.id, workspaceId, Number.isSafeInteger(limit) ? limit : 30) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createRunSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Task Run 请求格式不正确");
  const { workspaceId } = await context.params;
  if (!(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在");

  let sessionId: string | undefined;
  let parentRunId: string | undefined;
  let continuationMessages: Array<{ role: "user"; content: string; timestamp: number }> | undefined;
  if (parsed.data.continueFromRunId) {
    try {
      const continuation = await prepareContinuation({ userId: user.id, workspaceId, continueFromRunId: parsed.data.continueFromRunId });
      sessionId = continuation.sessionId;
      parentRunId = continuation.parentRunId;
      continuationMessages = await buildContinuationMessages({ userId: user.id, runId: parsed.data.continueFromRunId });
    } catch (cause) {
      if (cause instanceof ContinuationError) return apiError(cause.code, 409, cause.message);
      throw cause;
    }
  }

  try {
    const claim = await claimIdempotency({
      userId: user.id,
      scope: `workspace.${workspaceId}.run.create`,
      key: request.headers.get("idempotency-key"),
      body: parsed.data,
      resourceId: `run_${randomUUID()}`,
    });
    if (claim.replayed) {
      const run = await getTaskRun(user.id, claim.resourceId);
      if (run) return NextResponse.json({ run, replayed: true }, { headers: { "cache-control": "no-store" } });
      return apiError("IDEMPOTENCY_RECOVERY_PENDING", 409, "请求正在恢复，请稍后重试");
    }

    const run = await createTaskRun({ runId: claim.resourceId, userId: user.id, workspaceId, sessionId, parentRunId, ...parsed.data });
    if (!run) {
      const existing = await getTaskRun(user.id, claim.resourceId);
      if (existing) return NextResponse.json({ run: existing, replayed: true }, { headers: { "cache-control": "no-store" } });
      return apiError("WORKSPACE_RUN_ACTIVE", 409, "该 Workspace 已有运行中的任务");
    }
    void runAgentTask({ userId: user.id, runId: run.id, continuationMessages }).catch((error: unknown) => {
      console.error("Agent runtime start failed", { runId: run.id, error: error instanceof Error ? error.message : "unknown" });
    });
    return NextResponse.json({ run }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
