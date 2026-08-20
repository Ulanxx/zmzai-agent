import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { readFrameworkEvents } from "@/framework/core/events/bus";
import { defaultStore } from "@/framework/core/runtime/runner";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { ProjectModel } from "@/models/project";
import { ApprovalGrantModel, ApprovalRequestModel } from "@/models/approval";
import { SubagentRunModel } from "@/models/subagent-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({ projectId: z.string().trim().max(80).nullable() }).strict();

export async function GET(_: Request, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const task = await TaskModel.findOne({ taskId, userId: user.id }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const runs = await RunModel.find({ taskId, userId: user.id }).sort({ createdAt: -1 }).limit(50).lean();
  const sessionId = runs[0]?.sessionId;
  const session = sessionId ? await defaultStore.getSession(sessionId) : null;
  const messages = sessionId ? await defaultStore.getMessages(sessionId) : [];
  const events = sessionId ? await readFrameworkEvents(sessionId, 0, 5_000) : [];
  const [approvals, grants, subagents] = await Promise.all([
    ApprovalRequestModel.find({ taskId, requesterId: user.id }).sort({ createdAt: -1 }).lean(),
    ApprovalGrantModel.find({ taskId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ expiresAt: 1 }).lean(),
    SubagentRunModel.find({ taskId, userId: user.id }).sort({ createdAt: -1 }).lean(),
  ]);
  return NextResponse.json({ task, runs, session, messages, events, approvals, grants, subagents }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "任务更新请求格式不正确");
  if (parsed.data.projectId && !(await ProjectModel.exists({ projectId: parsed.data.projectId, userId: user.id }))) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  const task = await TaskModel.findOneAndUpdate({ taskId, userId: user.id }, { $set: { projectId: parsed.data.projectId } }, { new: true }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  return NextResponse.json({ task }, { headers: { "cache-control": "no-store" } });
}
