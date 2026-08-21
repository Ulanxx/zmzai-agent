import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { createFrameworkSession } from "@/framework/core/runtime/runner";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { getWorkspace } from "@/lib/workspaces";
import { createRunForTask, createTaskForSession, taskForSession } from "@/lib/task-run-control";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { canRunProject, getProjectAccess } from "@/lib/project-access";
import { ProjectBudgetExceededError } from "@/lib/project-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSessionSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(64),
    model: z.object({ providerId: z.string().trim().min(1).max(64), modelId: z.string().trim().min(1).max(160) }),
    prompt: z.string().trim().min(1).max(32 * 1024).optional(),
    taskId: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId") ?? undefined;
  const sessions = await defaultStore.listSessions({ userId: user.id, ...(workspaceId ? { workspaceId } : {}) });
  return NextResponse.json({ sessions }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createSessionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "会话请求格式不正确");

  const requestedTask = parsed.data.taskId ? await TaskModel.findOne({ taskId: parsed.data.taskId }).lean() : null;
  if (parsed.data.taskId && !requestedTask) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const taskAccess = requestedTask?.projectId ? await getProjectAccess(requestedTask.projectId, user.id) : requestedTask?.userId === user.id ? { role: "owner" as const, project: { userId: user.id } } : null;
  if (requestedTask && (!taskAccess || !canRunProject(taskAccess.role) || requestedTask.workspaceId !== parsed.data.workspaceId)) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const workspaceOwnerId = taskAccess?.project?.userId ?? user.id;
  const workspace = await getWorkspace(workspaceOwnerId, parsed.data.workspaceId);
  if (!workspace) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");

  let claim;
  try {
    claim = await claimIdempotency({
      userId: user.id,
      scope: "session.create",
      key: request.headers.get("idempotency-key"),
      body: parsed.data,
      resourceId: `ses_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }

  if (claim.replayed) {
    const existing = await defaultStore.getSession(claim.resourceId);
    if (existing) {
      const task = await taskForSession(existing.id);
      const run = task ? await RunModel.findOne({ taskId: task.taskId, userId: user.id }).sort({ createdAt: -1 }).lean() : null;
      return NextResponse.json({ session: existing, task, run, replayed: true }, { status: 201, headers: { "cache-control": "no-store" } });
    }
  }

  // Workspace = 智能体：session 绑定 workspace，配置从 workspace 实时读（agentResolver）。
  const session = await createFrameworkSession({
    store: defaultStore,
    id: claim.resourceId,
    userId: requestedTask ? workspaceOwnerId : user.id,
    workspaceId: parsed.data.workspaceId,
    agent: workspace.name,
    model: parsed.data.model,
    ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}),
  });

  const task = requestedTask ?? await createTaskForSession({ session, goal: parsed.data.prompt, title: session.title });
  // Create the draft Run even when the first request only establishes a
  // session for file upload. The subsequent prompt must discover this Task
  // through its Run instead of creating a second Task.
  let run;
  try { run = await createRunForTask({ task, session }); }
  catch (error) { if (error instanceof ProjectBudgetExceededError) return apiError("PROJECT_BUDGET_EXCEEDED", 429, "项目当前已达到并发运行上限，请稍后重试"); throw error; }

  if (parsed.data.prompt) {
    await getFrameworkRunner().prompt(session.id, { text: parsed.data.prompt });
  }
  return NextResponse.json({ session, task, run, replayed: claim.replayed }, { status: 201, headers: { "cache-control": "no-store" } });
}
