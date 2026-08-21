import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { cancelRunForSession, ensureRunForPrompt, pauseRunForSession } from "@/lib/task-run-control";
import { buildCheckpointResumeContext, latestCheckpointForRun } from "@/lib/task-checkpoint";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { canRunProject, getProjectAccess } from "@/lib/project-access";
import { canStartContinuationRun } from "@/lib/task-state-machine";
import { recordProductMetric } from "@/lib/product-metrics";

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
  const task = await TaskModel.findOne({ taskId }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const access = task.projectId ? await getProjectAccess(task.projectId, user.id) : task.userId === user.id ? { role: "owner" as const } : null;
  if (!access || !canRunProject(access.role)) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "任务操作请求格式不正确");
  const latestRun = await RunModel.findOne({ taskId }).sort({ createdAt: -1 }).lean();
  if (!latestRun) return apiError("RUN_NOT_FOUND", 409, "任务尚未创建执行实例");

  if (parsed.data.action === "pause") {
    const run = await pauseRunForSession(latestRun.sessionId);
    if (!run) return apiError("RUN_NOT_ACTIVE", 409, "任务当前不在执行中");
    await getFrameworkRunner().abort(latestRun.sessionId);
    return NextResponse.json({ task: await TaskModel.findOne({ taskId }).lean(), run }, { headers: { "cache-control": "no-store" } });
  }

  if (parsed.data.action === "cancel") {
    const run = await cancelRunForSession(latestRun.sessionId);
    if (!run) return apiError("RUN_NOT_ACTIVE", 409, "任务当前不在执行中");
    await getFrameworkRunner().abort(latestRun.sessionId);
    return NextResponse.json({ task: await TaskModel.findOne({ taskId }).lean(), run }, { headers: { "cache-control": "no-store" } });
  }

  if (!canStartContinuationRun(parsed.data.action, latestRun.status)) {
    return apiError("RUN_NOT_CONTINUABLE", 409, "当前执行仍在进行、等待审批或已完成当前阶段。请先暂停或取消后再创建新的执行尝试。");
  }
  if (latestRun.status === "waiting_input" && (!parsed.data.text || parsed.data.action !== "resume")) {
    return apiError("SIDE_EFFECT_CONFIRMATION_REQUIRED", 409, "上一次副作用结果不确定。请先确认外部状态，并在继续操作中说明确认结果。");
  }

  const session = await defaultStore.getSession(latestRun.sessionId);
  if (!session || session.workspaceId !== task.workspaceId) return apiError("SESSION_NOT_FOUND", 404, "任务会话不存在或无权访问");
  const checkpoint = parsed.data.action === "resume" || parsed.data.action === "retry" ? await latestCheckpointForRun({ runId: latestRun.runId, userId: task.userId }) : null;
  const checkpointContext = buildCheckpointResumeContext(checkpoint);
  const text = parsed.data.action === "follow_up" ? parsed.data.text : parsed.data.action === "retry" ? `请重试并完成原任务：${task.goal}${checkpointContext}` : `请从最近一次安全检查点继续完成任务。${checkpointContext}${latestRun.status === "waiting_input" ? `\n用户已确认外部状态：${parsed.data.text}` : ""}`;
  if (!text) return apiError("INVALID_BODY", 400, "后续任务内容不能为空");
  let claim;
  try {
    claim = await claimIdempotency({
      userId: user.id,
      scope: `task.${parsed.data.action}`,
      key: request.headers.get("idempotency-key"),
      body: parsed.data,
      resourceId: `run_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  const replayedRun = claim.replayed ? await RunModel.findOne({ runId: claim.resourceId, taskId }).lean() : null;
  if (replayedRun) return NextResponse.json({ accepted: true, queued: false, replayed: true, task, run: replayedRun }, { status: 202, headers: { "cache-control": "no-store" } });
  const control = await ensureRunForPrompt(session, text, { runIdOverride: claim.resourceId, parentRunId: latestRun.runId, resumeCheckpointId: latestRun.latestCheckpointId, forceNewRun: true });
  const result = await getFrameworkRunner().prompt(session.id, { text });
  if (parsed.data.action === "follow_up") {
    void recordProductMetric({ kind: "task_followed_up", userId: user.id, taskId: task.taskId, runId: control.run.runId }).catch((error) => {
      console.error("record task follow-up metric", error);
    });
  }
  return NextResponse.json({ accepted: true, queued: result.queued, task: control.task, run: control.run }, { status: 202, headers: { "cache-control": "no-store" } });
}
