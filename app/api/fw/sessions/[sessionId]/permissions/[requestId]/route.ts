import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { projectApprovalReply } from "@/lib/approval-projection";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { ApprovalRequestModel } from "@/models/approval";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replySchema = z
  .object({
    reply: z.enum(["once", "always", "reject"]),
    feedback: z.string().trim().max(2_000).optional(),
  })
  .strict();

export async function POST(request: NextRequest, context: { params: Promise<{ sessionId: string; requestId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId, requestId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");
  const run = await RunModel.findOne({ sessionId, active: true }).sort({ createdAt: -1 }).lean()
    ?? await RunModel.findOne({ sessionId }).sort({ createdAt: -1 }).lean();
  const task = run ? await TaskModel.findOne({ taskId: run.taskId }).lean() : null;
  const access = task?.projectId ? await getProjectAccess(task.projectId, user.id) : task?.userId === user.id ? { role: "owner" as const } : null;
  if (!task || !access || !canEditProject(access.role)) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");
  const approval = run
    ? await ApprovalRequestModel.findOne({ requestId, taskId: task.taskId, runId: run.runId, status: "pending" }).lean()
    : null;
  if (!approval) return apiError("PERMISSION_REQUEST_NOT_FOUND", 404, "审批请求不存在或已处理");

  const parsed = replySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "审批请求格式不正确");

  const resolved = await getFrameworkRunner().replyPermission(sessionId, requestId, parsed.data.reply, parsed.data.feedback);
  if (!resolved) return apiError("PERMISSION_REQUEST_NOT_FOUND", 404, "审批请求不存在或已处理");
  await projectApprovalReply({ sessionId, requestId, reply: parsed.data.reply, decidedBy: user.id, feedback: parsed.data.feedback });
  return NextResponse.json({ resolved: true }, { headers: { "cache-control": "no-store" } });
}
