import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { listSessionTaskRuns } from "@/lib/task-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 会话直达：返回该会话的全部轮次（升序）与其所属 Workspace。
 * 404 不泄露存在性（跨用户 / 不存在同样 404）。
 */
export async function GET(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId } = await context.params;
  const runs = await listSessionTaskRuns(user.id, sessionId);
  if (!runs.length) return apiError("SESSION_NOT_FOUND", 404, "会话不存在");
  return NextResponse.json({ sessionId, workspaceId: runs[0].workspaceId, runs }, { headers: { "cache-control": "no-store" } });
}
