import { NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { getFrameworkRunner } from "@/framework/server/context";
import { ApprovalGrantModel, ApprovalRequestModel } from "@/models/approval";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_: Request, context: { params: Promise<{ taskId: string; grantId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId, grantId } = await context.params;
  const task = await TaskModel.findOne({ taskId }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const access = task.projectId ? await getProjectAccess(task.projectId, user.id) : task.userId === user.id ? { role: "owner" as const } : null;
  if (!access || !canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能撤销任务授权");
  const grant = await ApprovalGrantModel.findOne({ grantId, taskId, revokedAt: null }).lean();
  if (!grant) return apiError("GRANT_NOT_FOUND", 404, "授权不存在、已过期或已撤销");

  const revokedAt = new Date();
  await ApprovalGrantModel.updateOne({ grantId, taskId, revokedAt: null }, { $set: { revokedAt } });
  await ApprovalRequestModel.updateOne({ requestId: grant.sourceRequestId, taskId, status: "approved" }, { $set: { status: "revoked", decidedAt: revokedAt, decidedBy: user.id } });
  const sourceRun = await RunModel.findOne({ runId: grant.sourceRunId, taskId }).select({ sessionId: 1 }).lean();
  if (sourceRun) await getFrameworkRunner().revokePermission(sourceRun.sessionId, grant.action, grant.resourceScope);
  return NextResponse.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
}
