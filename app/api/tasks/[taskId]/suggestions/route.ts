import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { readFrameworkEvents } from "@/framework/core/events/bus";
import { defaultStore } from "@/framework/core/runtime/runner";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { ApprovalRequestModel } from "@/models/approval";
import { SubagentRunModel } from "@/models/subagent-run";
import { getProjectAccess } from "@/lib/project-access";
import { buildTaskSuggestions } from "@/lib/task-suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 任务状态驱动的快捷指令：按最新 Run 状态/失败原因/质量检查失败项/审批与子任务状态动态生成。 */
export async function GET(_: Request, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const task = await TaskModel.findOne({ taskId }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const access = task.projectId ? await getProjectAccess(task.projectId, user.id) : task.userId === user.id ? { role: "owner" as const } : null;
  if (!access) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const runs = await RunModel.find({ taskId }).sort({ createdAt: -1 }).limit(5).lean();
  const sessionId = runs[0]?.sessionId;
  const [approvals, subagents, events] = await Promise.all([
    ApprovalRequestModel.find({ taskId }).sort({ createdAt: -1 }).lean(),
    SubagentRunModel.find({ taskId }).sort({ createdAt: -1 }).lean(),
    sessionId ? readFrameworkEvents(sessionId, 0, 5_000) : Promise.resolve([]),
  ]);
  const suggestions = buildTaskSuggestions({
    task: { goal: task.goal, status: task.status },
    latestRun: runs[0] ? { status: runs[0].status, terminalReason: runs[0].terminalReason } : null,
    approvals: approvals.map(({ status }) => ({ status })),
    subagents: subagents.map(({ status, description }) => ({ status, description })),
    events,
  });
  return NextResponse.json({ suggestions }, { headers: { "cache-control": "no-store" } });
}
