import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { ProjectContextItemModel } from "@/models/project-context-item";
import { canEditProject, getProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({ title: z.string().trim().min(1).max(160).optional(), content: z.string().max(64 * 1024).optional(), url: z.string().trim().url().max(2_000).optional(), enabled: z.boolean().optional() }).strict();

export async function PATCH(request: NextRequest, context: { params: Promise<{ projectId: string; contextId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId, contextId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能编辑项目上下文");
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "项目上下文更新格式不正确");
  const item = await ProjectContextItemModel.findOneAndUpdate({ contextId, projectId }, { $set: parsed.data }, { new: true }).lean();
  if (!item) return apiError("CONTEXT_NOT_FOUND", 404, "项目上下文不存在或无权访问");
  return NextResponse.json({ contextItem: item }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ projectId: string; contextId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId, contextId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能编辑项目上下文");
  const result = await ProjectContextItemModel.deleteOne({ contextId, projectId });
  if (!result.deletedCount) return apiError("CONTEXT_NOT_FOUND", 404, "项目上下文不存在或无权访问");
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
