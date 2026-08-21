import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError } from "@/lib/api-error";
import { claimIdempotency, IdempotencyError } from "@/lib/idempotency";
import { canRunProject, getProjectAccess } from "@/lib/project-access";
import { requireAgentApiKey, workspaceAllowed } from "@/lib/public-api";
import { createWideResearch, researchRoles, runWideResearch } from "@/lib/wide-research";
import { WideResearchJobModel } from "@/models/wide-research-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ workspace_id: z.string().trim().min(1).max(64), project_id: z.string().trim().min(1).max(80).optional(), question: z.string().trim().min(1).max(32 * 1024), roles: z.array(z.enum(researchRoles)).min(2).max(8).default(["资料检索", "事实核验", "反方审查"]), max_concurrency: z.number().int().min(1).max(4).default(3) }).strict();

export async function POST(request: NextRequest) {
  const authorized = await requireAgentApiKey(request, "tasks:write");
  if ("response" in authorized) return authorized.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Wide Research 请求格式不正确");
  if (!workspaceAllowed(authorized.key, parsed.data.workspace_id)) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  if (parsed.data.project_id) {
    const access = await getProjectAccess(parsed.data.project_id, authorized.key.userId);
    if (!access || access.project.workspaceId !== parsed.data.workspace_id) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
    if (!canRunProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能在此项目运行研究");
  }
  let claim;
  try {
    claim = await claimIdempotency({ userId: authorized.key.id, scope: "public.research.create", key: request.headers.get("idempotency-key"), body: parsed.data, resourceId: `ses_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  if (claim.replayed) {
    const existing = await WideResearchJobModel.findOne({ parentSessionId: claim.resourceId }).lean();
    if (existing) return NextResponse.json({ research_job_id: existing.researchJobId, task_id: existing.parentTaskId, run_id: existing.parentRunId, status: existing.status, replayed: true }, { status: 202 });
  }
  const created = await createWideResearch({ userId: authorized.key.userId, workspaceId: parsed.data.workspace_id, projectId: parsed.data.project_id ?? null, question: parsed.data.question, roles: parsed.data.roles, maxConcurrency: parsed.data.max_concurrency, sessionId: claim.resourceId });
  void runWideResearch(created.job.researchJobId).catch((error) => console.error("wide research", error));
  return NextResponse.json({ research_job_id: created.job.researchJobId, task_id: created.task.taskId, run_id: created.run.runId, status: "queued", child_count: created.job.children.length, replayed: false }, { status: 202, headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const authorized = await requireAgentApiKey(request, "tasks:read");
  if ("response" in authorized) return authorized.response;
  const id = request.nextUrl.searchParams.get("research_job_id")?.trim();
  if (!id) return apiError("INVALID_QUERY", 400, "research_job_id 必须提供");
  const job = await WideResearchJobModel.findOne({ researchJobId: id, userId: authorized.key.userId }).lean();
  if (!job || !workspaceAllowed(authorized.key, job.workspaceId)) return apiError("RESEARCH_NOT_FOUND", 404, "研究任务不存在或无权访问");
  return NextResponse.json({ research_job_id: job.researchJobId, task_id: job.parentTaskId, status: job.status, question: job.question, children: job.children.map((child) => ({ task_id: child.childTaskId, role: child.role, status: child.status, summary: child.summary, error: child.error })), failed_children: job.failedChildren, error: job.error }, { headers: { "cache-control": "no-store" } });
}
