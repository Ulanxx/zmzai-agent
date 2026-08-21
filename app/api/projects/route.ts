import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { getWorkspace } from "@/lib/workspaces";
import { TaskModel } from "@/models/task";
import { ProjectModel } from "@/models/project";
import { ProjectMemberModel } from "@/models/project-member";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ workspaceId: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(160), description: z.string().trim().max(4_000).default(""), instructions: z.string().max(64 * 1024).default("") }).strict();

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  const memberships = await ProjectMemberModel.find({ userId: user.id }).select({ projectId: 1 }).lean();
  const memberProjectIds = memberships.map((membership) => membership.projectId);
  const query: Record<string, unknown> = memberProjectIds.length ? { $or: [{ userId: user.id }, { projectId: { $in: memberProjectIds } }] } : { userId: user.id };
  if (workspaceId) query.workspaceId = workspaceId;
  const projects = await ProjectModel.find(query).sort({ updatedAt: -1 }).lean();
  const projectIds = projects.map((project) => project.projectId);
  const tasks = projectIds.length ? await TaskModel.find({ projectId: { $in: projectIds } }).select({ taskId: 1, projectId: 1, status: 1, title: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).lean() : [];
  const byProject = new Map<string, typeof tasks>();
  for (const task of tasks) if (task.projectId) byProject.set(task.projectId, [...(byProject.get(task.projectId) ?? []), task]);
  return NextResponse.json({ projects: projects.map((project) => ({ project, tasks: byProject.get(project.projectId) ?? [] })) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "项目请求格式不正确");
  if (!(await getWorkspace(user.id, parsed.data.workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  try {
    const claim = await claimIdempotency({ userId: user.id, scope: "project.create", key: request.headers.get("idempotency-key"), body: parsed.data, resourceId: `prj_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
    if (claim.replayed) {
      const existing = await ProjectModel.findOne({ projectId: claim.resourceId, userId: user.id }).lean();
      if (existing) return NextResponse.json({ project: existing, replayed: true }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    const project = await ProjectModel.create({ projectId: claim.resourceId, userId: user.id, ...parsed.data });
    return NextResponse.json({ project, replayed: claim.replayed }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
