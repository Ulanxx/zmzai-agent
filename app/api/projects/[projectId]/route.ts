import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { ProjectModel } from "@/models/project";
import { ProjectContextItemModel } from "@/models/project-context-item";
import { ProjectMemberModel } from "@/models/project-member";
import { ProjectArtifactModel } from "@/models/project-artifact";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { AutomationModel } from "@/models/automation";
import { AutomationExecutionModel } from "@/models/automation-execution";
import { AutomationWebhookEventModel } from "@/models/automation-webhook-event";
import { WideResearchJobModel } from "@/models/wide-research-job";
import { ProjectBudgetPolicyModel } from "@/models/project-budget-policy";
import { ProjectUsageEventModel } from "@/models/project-usage-event";
import { ProjectRelayUsageReconciliationModel } from "@/models/project-relay-usage-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), description: z.string().trim().max(4_000).optional(), instructions: z.string().max(64 * 1024).optional() }).strict();

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  const { project } = access;
  const tasks = await TaskModel.find({ projectId }).sort({ updatedAt: -1 }).lean();
  const runs = tasks.length ? await RunModel.find({ taskId: { $in: tasks.map((task) => task.taskId) } }).sort({ createdAt: -1 }).lean() : [];
  const contextItems = await ProjectContextItemModel.find({ projectId }).sort({ createdAt: -1 }).lean();
  const members = await ProjectMemberModel.find({ projectId }).sort({ createdAt: 1 }).lean();
  return NextResponse.json({ project, tasks, runs, contextItems, members, role: access.role }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "项目更新请求格式不正确");
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能编辑项目设置");
  const project = await ProjectModel.findOneAndUpdate({ projectId }, { $set: parsed.data }, { new: true }).lean();
  if (!project) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  return NextResponse.json({ project }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (access.role !== "owner") return apiError("FORBIDDEN", 403, "只有项目所有者可以删除项目");
  const deleted = await ProjectModel.deleteOne({ projectId, userId: user.id });
  if (!deleted.deletedCount) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  const automationIds = (await AutomationModel.find({ projectId }).select({ automationId: 1 }).lean()).map((automation) => automation.automationId);
  await TaskModel.updateMany({ projectId }, { $set: { projectId: null } });
  await Promise.all([
    ProjectContextItemModel.deleteMany({ projectId }),
    ProjectMemberModel.deleteMany({ projectId }),
    ProjectArtifactModel.deleteMany({ projectId }),
    AutomationModel.deleteMany({ projectId }),
    AutomationExecutionModel.deleteMany({ automationId: { $in: automationIds } }),
    AutomationWebhookEventModel.deleteMany({ automationId: { $in: automationIds } }),
    WideResearchJobModel.updateMany({ projectId }, { $set: { projectId: null } }),
    ProjectBudgetPolicyModel.deleteMany({ projectId }),
    ProjectUsageEventModel.deleteMany({ projectId }),
    ProjectRelayUsageReconciliationModel.deleteMany({ projectId }),
  ]);
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
