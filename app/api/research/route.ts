import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { claimIdempotency, IdempotencyError } from "@/lib/idempotency";
import { canRunProject, getProjectAccess } from "@/lib/project-access";
import { getWorkspace } from "@/lib/workspaces";
import { createWideResearch, researchRoles, runWideResearch } from "@/lib/wide-research";
import { WideResearchJobModel } from "@/models/wide-research-job";
import { decodeSessionUpload, SessionFileUploadError, uploadPath } from "@/lib/session-file-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  workspaceId: z.string().trim().min(1).max(64),
  projectId: z.string().trim().min(1).max(80).nullable().optional(),
  question: z.string().trim().min(1).max(32 * 1024),
  roles: z.array(z.enum(researchRoles)).min(2).max(8).default(["资料检索", "事实核验", "反方审查"]),
  maxConcurrency: z.number().int().min(1).max(4).default(3),
}).strict();

type ResearchUpload = { path: string; name: string; size: number; content: string };

async function readResearchRequest(request: NextRequest): Promise<{ body: unknown; files: ResearchUpload[] }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) return { body: await request.json().catch(() => null), files: [] };
  const form = await request.formData();
  const files: ResearchUpload[] = [];
  for (const value of form.getAll("files")) {
    if (!(value instanceof File)) continue;
    const path = uploadPath({ filename: value.name, requestedPath: value.name });
    const content = decodeSessionUpload(new Uint8Array(await value.arrayBuffer()));
    files.push({ path, name: value.name, size: value.size, content });
    if (files.length > 10) throw new SessionFileUploadError("TOO_LARGE", "研究资料不能超过 10 个文件");
  }
  let roles: unknown = undefined;
  const rawRoles = form.get("roles");
  if (typeof rawRoles === "string" && rawRoles.trim()) roles = JSON.parse(rawRoles);
  return {
    body: {
      workspaceId: form.get("workspaceId"),
      projectId: form.get("projectId") || null,
      question: form.get("question"),
      ...(roles === undefined ? {} : { roles }),
      ...(form.get("maxConcurrency") ? { maxConcurrency: Number(form.get("maxConcurrency")) } : {}),
    },
    files,
  };
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  let requestData: { body: unknown; files: ResearchUpload[] };
  try { requestData = await readResearchRequest(request); } catch (error) {
    if (error instanceof SessionFileUploadError) return apiError(error.code, error.code === "TOO_LARGE" ? 413 : 400, error.message);
    return apiError("INVALID_BODY", 400, "研究请求格式不正确");
  }
  const parsed = schema.safeParse(requestData.body);
  if (!parsed.success) return apiError("INVALID_BODY", 400, "研究请求格式不正确");
  if (!(await getWorkspace(user.id, parsed.data.workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  if (parsed.data.projectId) {
    const access = await getProjectAccess(parsed.data.projectId, user.id);
    if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
    if (!canRunProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能在此项目运行研究");
  }
  let claim;
  try {
    claim = await claimIdempotency({
      userId: user.id,
      scope: "research.create",
      key: request.headers.get("idempotency-key"),
      body: {
        ...parsed.data,
        files: requestData.files.map(({ path, name, size }) => ({ path, name, size })),
      },
      resourceId: `ses_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  if (claim.replayed) {
    const existing = await WideResearchJobModel.findOne({ parentSessionId: claim.resourceId, userId: user.id }).lean();
    if (existing) return NextResponse.json({ researchJobId: existing.researchJobId, taskId: existing.parentTaskId, runId: existing.parentRunId, status: existing.status, replayed: true }, { status: 202 });
  }
  const created = await createWideResearch({ userId: user.id, workspaceId: parsed.data.workspaceId, projectId: parsed.data.projectId ?? null, question: parsed.data.question, roles: parsed.data.roles, maxConcurrency: parsed.data.maxConcurrency, sessionId: claim.resourceId, files: requestData.files });
  void runWideResearch(created.job.researchJobId).catch((error) => console.error("first-party wide research", error));
  return NextResponse.json({ researchJobId: created.job.researchJobId, taskId: created.task.taskId, runId: created.run.runId, status: "queued", childCount: created.job.children.length, replayed: false }, { status: 202, headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const researchJobId = request.nextUrl.searchParams.get("researchJobId")?.trim();
  if (researchJobId) {
    const job = await WideResearchJobModel.findOne({ researchJobId, userId: user.id }).lean();
    if (!job) return apiError("RESEARCH_NOT_FOUND", 404, "研究任务不存在或无权访问");
    return NextResponse.json({
      research: {
        researchJobId: job.researchJobId,
        taskId: job.parentTaskId,
        runId: job.parentRunId,
        sessionId: job.parentSessionId,
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        question: job.question,
        roles: job.roles,
        maxConcurrency: job.maxConcurrency,
        status: job.status,
        synthesisStatus: job.synthesisStatus,
        childCount: job.children.length,
        completedChildren: job.children.filter((child) => child.status === "succeeded").length,
        failedChildren: job.failedChildren,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        children: job.children.map((child) => ({
          taskId: child.childTaskId,
          runId: child.childRunId,
          role: child.role,
          status: child.status,
          summary: child.summary,
          error: child.error,
          startedAt: child.startedAt,
          finishedAt: child.finishedAt,
        })),
      },
    }, { headers: { "cache-control": "no-store" } });
  }

  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 30) || 30, 1), 100);
  const status = request.nextUrl.searchParams.get("status")?.trim();
  const query: Record<string, unknown> = { userId: user.id };
  if (["queued", "running", "succeeded", "failed"].includes(status ?? "")) query.status = status;
  const jobs = await WideResearchJobModel.find(query).sort({ updatedAt: -1 }).limit(limit).lean();
  return NextResponse.json({ researches: jobs.map((job) => ({
    researchJobId: job.researchJobId,
    taskId: job.parentTaskId,
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    question: job.question,
    status: job.status,
    synthesisStatus: job.synthesisStatus,
    childCount: job.children.length,
    completedChildren: job.children.filter((child) => child.status === "succeeded").length,
    failedChildren: job.failedChildren,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  })) }, { headers: { "cache-control": "no-store" } });
}
