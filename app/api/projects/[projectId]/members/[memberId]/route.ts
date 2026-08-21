import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { canManageMembers, getProjectAccess } from "@/lib/project-access";
import { ProjectMemberModel } from "@/models/project-member";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({ role: z.enum(["viewer", "member", "editor"]) }).strict();

export async function PATCH(request: NextRequest, context: { params: Promise<{ projectId: string; memberId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId, memberId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canManageMembers(access.role)) return apiError("FORBIDDEN", 403, "只有项目所有者可以管理成员");
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "成员角色格式不正确");
  const member = await ProjectMemberModel.findOneAndUpdate({ projectId, memberId }, { $set: parsed.data }, { new: true }).lean();
  if (!member) return apiError("MEMBER_NOT_FOUND", 404, "项目成员不存在");
  return NextResponse.json({ member }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ projectId: string; memberId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId, memberId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canManageMembers(access.role)) return apiError("FORBIDDEN", 403, "只有项目所有者可以管理成员");
  const deleted = await ProjectMemberModel.deleteOne({ projectId, memberId });
  if (!deleted.deletedCount) return apiError("MEMBER_NOT_FOUND", 404, "项目成员不存在");
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
