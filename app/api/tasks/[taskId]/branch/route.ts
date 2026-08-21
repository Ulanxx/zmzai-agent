import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const branchSchema = z.object({ title: z.string().trim().min(1).max(240).optional(), goal: z.string().trim().min(1).max(32 * 1024).optional() }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const source = await TaskModel.findOne({ taskId }).lean();
  if (!source) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const access = source.projectId ? await getProjectAccess(source.projectId, user.id) : source.userId === user.id ? { role: "owner" as const, project: null } : null;
  if (!access || !canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能创建任务分支");
  const parsed = branchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "任务分支格式不正确");
  let claim;
  try {
    claim = await claimIdempotency({ userId: user.id, scope: "task.branch", key: request.headers.get("idempotency-key"), body: { taskId, ...parsed.data }, resourceId: `task_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  const existing = claim.replayed ? await TaskModel.findOne({ taskId: claim.resourceId }).lean() : null;
  if (existing) return NextResponse.json({ task: existing, replayed: true }, { status: 201, headers: { "cache-control": "no-store" } });
  const task = await TaskModel.create({
    taskId: claim.resourceId,
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    userId: source.userId,
    title: parsed.data.title ?? `${source.title || "未命名任务"} · 分支`,
    goal: parsed.data.goal ?? source.goal,
    parentTaskId: source.taskId,
    sourceTaskVersionId: `${source.taskId}:v${source.version}`,
    status: "draft",
    activeRunId: null,
    latestRunId: null,
    version: 1,
  });
  return NextResponse.json({ task, replayed: false }, { status: 201, headers: { "cache-control": "no-store" } });
}
