import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { cancelActiveAgentRun } from "@/lib/agent-runtime";
import { abortActiveExecution } from "@/lib/execution-resume";
import { cancelAgentSandboxRun } from "@/lib/sandbox-client";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { cancelTaskRun } from "@/lib/task-runs";
import { ExecutionProposalModel } from "@/models/execution-proposal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { runId } = await context.params;
  try {
    await claimIdempotency({
      userId: user.id,
      scope: `run.${runId}.cancel`,
      key: request.headers.get("idempotency-key"),
      body: {},
      resourceId: runId,
    });
    cancelActiveAgentRun(runId);
    abortActiveExecution(runId);
    // Cascade-cancel any in-flight Sandbox run for this task run (idempotent).
    const activeExecutions = await ExecutionProposalModel.find({ runId, userId: user.id, status: "approved", sandboxRunId: { $ne: null } }).select({ sandboxRunId: 1 }).lean();
    await Promise.all(activeExecutions.map((proposal) => cancelAgentSandboxRun(proposal.sandboxRunId as string).catch(() => undefined)));
    const run = await cancelTaskRun(user.id, runId);
    if (!run) return apiError("RUN_NOT_FOUND", 404, "Task Run 不存在");
    return NextResponse.json({ run }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
