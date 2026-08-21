import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { readFrameworkEvents } from "@/framework/core/events/bus";
import { apiError, unauthenticated } from "@/lib/api-error";
import { canRunProject, getProjectAccess } from "@/lib/project-access";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureRunForPrompt } from "@/lib/task-run-control";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const planActionSchema = z.object({
  action: z.enum(["skip", "rerun", "adjust"]),
  index: z.number().int().min(0).max(255).optional(),
  instruction: z.string().trim().min(1).max(8_000).optional(),
}).strict().superRefine((value, context) => {
  if ((value.action === "skip" || value.action === "rerun") && value.index === undefined) context.addIssue({ code: "custom", path: ["index"], message: "计划步骤不能为空" });
  if (value.action === "adjust" && !value.instruction) context.addIssue({ code: "custom", path: ["instruction"], message: "计划调整内容不能为空" });
});

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const task = await TaskModel.findOne({ taskId }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const access = task.projectId ? await getProjectAccess(task.projectId, user.id) : task.userId === user.id ? { role: "owner" as const } : null;
  if (!access || !canRunProject(access.role)) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const parsed = planActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "计划操作格式不正确");

  const latestRun = await RunModel.findOne({ taskId }).sort({ createdAt: -1 }).lean();
  if (!latestRun) return apiError("RUN_NOT_FOUND", 409, "任务尚未创建执行实例");
  const session = await defaultStore.getSession(latestRun.sessionId);
  if (!session) return apiError("SESSION_NOT_FOUND", 404, "任务会话不存在");
  const events = await readFrameworkEvents(session.id, 0, 5_000);
  const latestTodoEvent = [...events].reverse().find((event) => event.type === "todo.updated");
  const todo = latestTodoEvent?.type === "todo.updated" ? latestTodoEvent.data.todos[parsed.data.index ?? -1] : undefined;
  if ((parsed.data.action === "skip" || parsed.data.action === "rerun") && !todo) return apiError("PLAN_STEP_NOT_FOUND", 404, "计划步骤不存在");

  const text = parsed.data.action === "skip"
    ? `请将执行计划第 ${parsed.data.index! + 1} 步“${todo!.content}”标记为已跳过（使用 cancelled 状态），并继续执行其余计划。不要重复已完成的步骤。`
    : parsed.data.action === "rerun"
      ? `请重新执行执行计划第 ${parsed.data.index! + 1} 步“${todo!.content}”，先检查当前 Workspace 和已生成成果，避免重复安全副作用；完成后继续剩余计划。`
      : `请调整当前执行计划：${parsed.data.instruction}\n保留已经完成且仍然有效的步骤，并说明调整后的下一步。`;
  const control = await ensureRunForPrompt(session, text, {
    ...(latestRun.status === "succeeded" || latestRun.status === "failed" || latestRun.status === "cancelled" ? { forceNewRun: true, parentRunId: latestRun.runId, resumeCheckpointId: latestRun.latestCheckpointId } : {}),
  });
  const result = await getFrameworkRunner().prompt(session.id, { text });
  return NextResponse.json({ accepted: true, queued: result.queued, task: control.task, run: control.run }, { status: 202, headers: { "cache-control": "no-store" } });
}
