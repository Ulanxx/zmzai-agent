import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { getWorkspace } from "@/lib/workspaces";
import { initializeAutomationSchedule } from "@/lib/automation-scheduler";
import { isSupportedSchedule, isSupportedTimeZone } from "@/lib/automation-schedule";
import { AutomationModel } from "@/models/automation";
import { ProjectMemberModel } from "@/models/project-member";
import { canEditProject, getProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ workspaceId: z.string().trim().min(1).max(64), projectId: z.string().trim().min(1).max(80).optional(), name: z.string().trim().min(1).max(160), goal: z.string().trim().min(1).max(32 * 1024), schedule: z.string().trim().max(120).default("手动运行"), timezone: z.string().trim().max(64).default("Asia/Shanghai") }).strict();

function summary(record: { automationId: string; workspaceId: string; projectId?: string | null; sourceTaskId?: string | null; name: string; goal: string; schedule: string; timezone: string; status: string; lastRunAt?: Date | null; nextRunAt?: Date | null; lastRunStatus: string; lastError?: string | null; lastRunTaskId?: string | null; lastRunId?: string | null; webhookSecretPrefix?: string | null; createdAt: Date; updatedAt: Date }) {
  return { automationId: record.automationId, workspaceId: record.workspaceId, projectId: record.projectId ?? null, sourceTaskId: record.sourceTaskId ?? null, name: record.name, goal: record.goal, schedule: record.schedule, timezone: record.timezone, status: record.status, lastRunAt: record.lastRunAt?.toISOString() ?? null, nextRunAt: record.nextRunAt?.toISOString() ?? null, lastRunStatus: record.lastRunStatus, lastError: record.lastError ?? null, lastRunTaskId: record.lastRunTaskId ?? null, lastRunId: record.lastRunId ?? null, webhookSecretPrefix: record.webhookSecretPrefix ?? null, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const memberships = await ProjectMemberModel.find({ userId: user.id }).select({ projectId: 1 }).lean();
  const projectIds = memberships.map((membership) => membership.projectId);
  const automations = await AutomationModel.find(projectIds.length ? { $or: [{ userId: user.id }, { projectId: { $in: projectIds } }] } : { userId: user.id }).sort({ updatedAt: -1 }).lean();
  return NextResponse.json({ automations: automations.map(summary) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "自动化请求格式不正确");
  if (!isSupportedSchedule(parsed.data.schedule)) return apiError("INVALID_SCHEDULE", 400, "计划仅支持手动运行、每天 HH:mm、工作日 HH:mm、每小时或五段 cron");
  if (!isSupportedTimeZone(parsed.data.timezone)) return apiError("INVALID_TIMEZONE", 400, "时区必须是有效的 IANA 时区，例如 Asia/Shanghai");
  const projectAccess = parsed.data.projectId ? await getProjectAccess(parsed.data.projectId, user.id) : null;
  if (parsed.data.projectId && (!projectAccess || !canEditProject(projectAccess.role) || projectAccess.project.workspaceId !== parsed.data.workspaceId)) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  const automationOwnerId = projectAccess?.project.userId ?? user.id;
  if (!(await getWorkspace(automationOwnerId, parsed.data.workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  try {
    const claim = await claimIdempotency({ userId: user.id, scope: "automation.create", key: request.headers.get("idempotency-key"), body: parsed.data, resourceId: `aut_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
    if (claim.replayed) {
      const existing = await AutomationModel.findOne({ automationId: claim.resourceId }).lean();
      if (existing) return NextResponse.json({ automation: summary(existing), replayed: true }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    const automation = await AutomationModel.create({ automationId: claim.resourceId, userId: automationOwnerId, ...parsed.data, nextRunAt: await initializeAutomationSchedule(parsed.data) });
    return NextResponse.json({ automation: summary(automation), }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
