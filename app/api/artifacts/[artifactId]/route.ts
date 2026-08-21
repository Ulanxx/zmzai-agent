import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { getArtifactAccess } from "@/lib/artifact-access";
import { canEditProject } from "@/lib/project-access";
import { deleteArtifactFiles } from "@/lib/artifact-storage";
import { ProjectArtifactModel } from "@/models/project-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(12).optional(),
}).strict().refine((value) => !value.tags || new Set(value.tags.map((tag) => tag.toLowerCase())).size === value.tags.length, { message: "标签不能重复", path: ["tags"] });

export async function PATCH(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { artifactId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "成果更新请求格式不正确");
  const artifactAccess = await getArtifactAccess(artifactId, user.id);
  if (!artifactAccess) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  if (artifactAccess.access && !canEditProject(artifactAccess.access.role)) return apiError("FORBIDDEN", 403, "当前角色不能编辑成果");
  const artifact = await SandboxArtifactModel.findOneAndUpdate({ artifactId }, { $set: parsed.data }, { new: true }).lean();
  if (!artifact) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  return NextResponse.json({ artifact }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { artifactId } = await context.params;
  const artifactAccess = await getArtifactAccess(artifactId, user.id);
  if (!artifactAccess) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  if (artifactAccess.access && !canEditProject(artifactAccess.access.role)) return apiError("FORBIDDEN", 403, "当前角色不能删除成果");
  if (artifactAccess.artifact.gridFsFileId) await deleteArtifactFiles([artifactAccess.artifact.gridFsFileId]);
  const deleted = await SandboxArtifactModel.deleteOne({ artifactId });
  if (!deleted.deletedCount) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  await ProjectArtifactModel.deleteMany({ artifactId });
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
