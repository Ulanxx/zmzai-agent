import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { getArtifactAccess } from "@/lib/artifact-access";
import { ProjectArtifactModel } from "@/models/project-artifact";
import { ProjectModel } from "@/models/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { artifactId } = await context.params;
  const body = await request.json().catch(() => null) as { projectId?: unknown } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) return apiError("INVALID_BODY", 400, "项目不能为空");
  const project = await ProjectModel.findOne({ projectId }).select({ projectId: 1, workspaceId: 1, userId: 1 }).lean();
  const access = project ? await getProjectAccess(projectId, user.id) : null;
  if (!project || !access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能管理项目成果");
  const artifactAccess = await getArtifactAccess(artifactId, user.id);
  if (!artifactAccess) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  const reference = await ProjectArtifactModel.findOneAndUpdate(
    { projectId, artifactId },
    { $setOnInsert: { referenceId: `par_${randomUUID().replaceAll("-", "").slice(0, 20)}`, projectId, workspaceId: project.workspaceId, artifactId, artifactOwnerId: artifactAccess.artifact.userId, addedBy: user.id } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return NextResponse.json({ reference }, { status: 201, headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request, context: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { artifactId } = await context.params;
  const projectId = new URL(request.url).searchParams.get("projectId")?.trim() ?? "";
  const access = projectId ? await getProjectAccess(projectId, user.id) : null;
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能管理项目成果");
  const deleted = await ProjectArtifactModel.deleteOne({ projectId, artifactId });
  if (!deleted.deletedCount) return apiError("REFERENCE_NOT_FOUND", 404, "项目成果引用不存在");
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
