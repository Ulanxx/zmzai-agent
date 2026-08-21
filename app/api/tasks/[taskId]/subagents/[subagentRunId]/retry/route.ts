import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { defaultStore, createFrameworkSession } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { canRunProject, getProjectAccess } from "@/lib/project-access";
import { SubagentRunModel } from "@/models/subagent-run";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string; subagentRunId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId, subagentRunId } = await context.params;
  const source = await SubagentRunModel.findOne({ subagentRunId, taskId }).lean();
  if (!source) return apiError("SUBAGENT_NOT_FOUND", 404, "子任务不存在或无权访问");
  const task = await TaskModel.findOne({ taskId }).select({ projectId: 1, userId: 1 }).lean();
  const access = task?.projectId ? await getProjectAccess(task.projectId, user.id) : task?.userId === user.id ? { role: "owner" as const } : null;
  if (!access || !canRunProject(access.role)) return apiError("SUBAGENT_NOT_FOUND", 404, "子任务不存在或无权访问");
  if (source.status !== "failed") return apiError("SUBAGENT_NOT_RETRYABLE", 409, "只有失败的子任务可以局部重试");
  const parent = await defaultStore.getSession(source.parentSessionId);
  if (!parent) return apiError("PARENT_SESSION_NOT_FOUND", 404, "父任务会话不存在或无权访问");
  let claim;
  try {
    claim = await claimIdempotency({ userId: user.id, scope: "subagent.retry", key: request.headers.get("idempotency-key"), body: { taskId, subagentRunId }, resourceId: `ses_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  if (claim.replayed) {
    const existing = await SubagentRunModel.findOne({ childSessionId: claim.resourceId }).lean();
    if (existing) return NextResponse.json({ subagent: existing, replayed: true }, { status: 202, headers: { "cache-control": "no-store" } });
  }
  const session = await createFrameworkSession({
    id: claim.resourceId,
    store: defaultStore,
    userId: source.userId,
    workspaceId: source.workspaceId,
    parentId: source.parentSessionId,
    agent: source.agent,
    model: parent.model,
    permission: parent.permission,
    prompt: source.prompt,
    title: source.description,
  });
  const subagent = await SubagentRunModel.create({
    subagentRunId: `subrun_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    parentSubagentRunId: source.subagentRunId,
    taskId: source.taskId,
    parentRunId: source.parentRunId,
    parentSessionId: source.parentSessionId,
    childSessionId: session.id,
    userId: source.userId,
    workspaceId: source.workspaceId,
    agent: source.agent,
    description: source.description,
    prompt: source.prompt,
    status: "queued",
  });
  const result = await getFrameworkRunner().prompt(session.id, { text: source.prompt, agent: source.agent });
  return NextResponse.json({ subagent, session, queued: result.queued }, { status: 202, headers: { "cache-control": "no-store" } });
}
