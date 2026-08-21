import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { initializeAutomationSchedule } from "@/lib/automation-scheduler";
import { isSupportedSchedule } from "@/lib/automation-schedule";
import { AutomationModel } from "@/models/automation";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), schedule: z.string().trim().min(1).max(120).optional() }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const task = await TaskModel.findOne({ taskId }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const access = task.projectId ? await getProjectAccess(task.projectId, user.id) : task.userId === user.id ? { role: "owner" as const } : null;
  if (!access) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  if (access.role !== "owner" && !canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能保存自动化模板");
  if (task.status !== "succeeded") return apiError("TASK_NOT_COMPLETE", 409, "只有已完成任务可以保存为自动化模板");
  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "自动化模板格式不正确");
  const schedule = parsed.data.schedule ?? "手动运行";
  if (!isSupportedSchedule(schedule)) return apiError("INVALID_SCHEDULE", 400, "计划仅支持手动运行、每天 HH:mm、工作日 HH:mm、每小时或五段 cron");
  let claim;
  try {
    claim = await claimIdempotency({ userId: user.id, scope: "task.automation", key: request.headers.get("idempotency-key"), body: { taskId, ...parsed.data }, resourceId: `aut_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  const existing = claim.replayed ? await AutomationModel.findOne({ automationId: claim.resourceId }).lean() : null;
  if (existing) return NextResponse.json({ automation: existing, replayed: true }, { status: 201, headers: { "cache-control": "no-store" } });
  const automation = await AutomationModel.create({
    automationId: claim.resourceId,
    userId: task.userId,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    sourceTaskId: task.taskId,
    name: parsed.data.name ?? `${task.title || "未命名任务"} · 自动化`,
    goal: task.goal,
    schedule,
    nextRunAt: await initializeAutomationSchedule({ schedule, timezone: "Asia/Shanghai" }),
  });
  return NextResponse.json({ automation, replayed: false }, { status: 201, headers: { "cache-control": "no-store" } });
}
