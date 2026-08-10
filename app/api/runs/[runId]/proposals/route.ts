import { NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { listRunExecutionProposals } from "@/lib/execution-proposals";
import { listRunProposals } from "@/lib/proposals";
import { getTaskRun } from "@/lib/task-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { runId } = await context.params;
  if (!(await getTaskRun(user.id, runId))) return apiError("RUN_NOT_FOUND", 404, "Task Run 不存在");
  const [changes, executions] = await Promise.all([
    listRunProposals({ userId: user.id, runId }),
    listRunExecutionProposals({ userId: user.id, runId }),
  ]);
  return NextResponse.json({ proposals: [...changes, ...executions] }, { headers: { "cache-control": "no-store" } });
}
