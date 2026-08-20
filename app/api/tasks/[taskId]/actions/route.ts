import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { cancelRunForSession, ensureRunForPrompt, pauseRunForSession } from "@/lib/task-run-control";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actionSchema = z.object({
  action: z.enum(["pause", "resume", "retry", "cancel", "follow_up"]),
  text: z.string().trim().min(1).max(32 * 1024).optional(),
}).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const task = await TaskModel.findOne({ taskId, userId: user.id }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "任务操作请求格式不正确");
  const latestRun = await RunModel.findOne({ taskId, userId: user.id }).sort({ createdAt: -1 }).lean();
  if (!latestRun) return apiError("RUN_NOT_FOUND", 409, "任务尚未创建执行实例");

  if (parsed.data.action === "pause") {
    const run = await pauseRunForSession(latestRun.sessionId);
    if (!run) return apiError("RUN_NOT_ACTIVE", 409, "任务当前不在执行中");
    await getFrameworkRunner().abort(latestRun.sessionId);
    return NextResponse.json({ task: await TaskModel.findOne({ taskId, userId: user.id }).lean(), run }, { headers: { "cache-control": "no-store" } });
  }

  if (parsed.data.action === "cancel") {
    const run = await cancelRunForSession(latestRun.sessionId);
    if (!run) return apiError("RUN_NOT_ACTIVE", 409, "任务当前不在执行中");
    await getFrameworkRunner().abort(latestRun.sessionId);
    return NextResponse.json({ task: await TaskModel.findOne({ taskId, userId: user.id }).lean(), run }, { headers: { "cache-control": "no-store" } });
  }

  const session = await defaultStore.getSession(latestRun.sessionId);
  if (!session || session.userId !== user.id) return apiError("SESSION_NOT_FOUND", 404, "任务会话不存在或无权访问");
  const text = parsed.data.action === "follow_up" ? parsed.data.text : parsed.data.action === "retry" ? `请重试并完成原任务：${task.goal}` : "请从最近一次安全检查点继续完成任务。";
  if (!text) return apiError("INVALID_BODY", 400, "后续任务内容不能为空");
  const control = await ensureRunForPrompt(session, text);
  const result = await getFrameworkRunner().prompt(session.id, { text });
  return NextResponse.json({ accepted: true, queued: result.queued, task: control.task, run: control.run }, { status: 202, headers: { "cache-control": "no-store" } });
}
