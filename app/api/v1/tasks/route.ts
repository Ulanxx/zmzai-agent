import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createFrameworkSession, defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { apiError } from "@/lib/api-error";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { getProjectAccess, canRunProject } from "@/lib/project-access";
import { workspaceAllowed, requireAgentApiKey } from "@/lib/public-api";
import { isSupportedOutputSchema } from "@/lib/structured-output";
import { createRunForTask, createTaskForSession, taskForSession } from "@/lib/task-run-control";
import { getWorkspace } from "@/lib/workspaces";
import { RunModel, type RunRecord } from "@/models/run";
import { ProjectBudgetExceededError } from "@/lib/project-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  workspace_id: z.string().trim().min(1).max(64),
  project_id: z.string().trim().min(1).max(80).optional(),
  prompt: z.string().trim().min(1).max(32 * 1024),
  title: z.string().trim().min(1).max(240).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
}).strict();

function outputContract(schema: Record<string, unknown>): string {
  return `\n\n[结构化输出契约]\n完成正常说明后，最后必须输出一个且仅一个 \`json\` 代码块。代码块内必须是匹配以下 JSON Schema 的对象；不要在代码块后追加文字。\n${JSON.stringify(schema)}`;
}

export async function POST(request: NextRequest) {
  const authorized = await requireAgentApiKey(request, "tasks:write");
  if ("response" in authorized) return authorized.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "任务请求格式不正确");
  if (parsed.data.output_schema && !isSupportedOutputSchema(parsed.data.output_schema)) return apiError("INVALID_OUTPUT_SCHEMA", 400, "output_schema 不属于支持的 JSON Schema 子集");
  if (!workspaceAllowed(authorized.key, parsed.data.workspace_id)) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");

  const projectAccess = parsed.data.project_id ? await getProjectAccess(parsed.data.project_id, authorized.key.userId) : null;
  if (parsed.data.project_id && (!projectAccess || !canRunProject(projectAccess.role) || projectAccess.project.workspaceId !== parsed.data.workspace_id)) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  const workspaceOwnerId = projectAccess?.project.userId ?? authorized.key.userId;
  const workspace = await getWorkspace(workspaceOwnerId, parsed.data.workspace_id);
  if (!workspace) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");

  let claim;
  try {
    claim = await claimIdempotency({ userId: authorized.key.id, scope: "public.task.create", key: request.headers.get("idempotency-key"), body: parsed.data, resourceId: `ses_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  const prompt = parsed.data.output_schema ? `${parsed.data.prompt}${outputContract(parsed.data.output_schema)}` : parsed.data.prompt;
  let session = await defaultStore.getSession(claim.resourceId);
  if (!session) session = await createFrameworkSession({ store: defaultStore, id: claim.resourceId, userId: workspaceOwnerId, workspaceId: workspace.id, agent: workspace.name, model: { providerId: "relay", modelId: workspace.defaultModel }, prompt, title: parsed.data.title ?? parsed.data.prompt.slice(0, 80) });
  let task = await taskForSession(session.id);
  const existingRun = task ? await RunModel.findOne({ taskId: task.taskId }).sort({ createdAt: -1 }).lean() as RunRecord | null : null;
  if (task && existingRun && claim.replayed) return NextResponse.json({ task_id: task.taskId, run_id: existingRun.runId, session_id: session.id, status: existingRun.status, replayed: true }, { status: 202, headers: { "cache-control": "no-store" } });
  if (!task) task = await createTaskForSession({ session, goal: parsed.data.prompt, title: parsed.data.title, projectId: parsed.data.project_id ?? null, source: "api", outputSchema: parsed.data.output_schema ?? null });
  let run: RunRecord;
  try { run = existingRun ?? await createRunForTask({ task, session }); }
  catch (error) { if (error instanceof ProjectBudgetExceededError) return apiError("PROJECT_BUDGET_EXCEEDED", 429, "项目当前已达到并发运行上限，请稍后重试"); throw error; }
  await getFrameworkRunner().prompt(session.id, { text: prompt });
  return NextResponse.json({ task_id: task.taskId, run_id: run.runId, session_id: session.id, status: "queued", replayed: claim.replayed }, { status: 202, headers: { "cache-control": "no-store" } });
}
