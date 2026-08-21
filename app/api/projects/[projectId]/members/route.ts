import { randomUUID } from "node:crypto";

import { UserModel } from "@zmzai/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { canManageMembers, getProjectAccess } from "@/lib/project-access";
import { ProjectMemberModel } from "@/models/project-member";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ email: z.string().trim().email().max(254), role: z.enum(["viewer", "member", "editor"]).default("member") }).strict();

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  const members = await ProjectMemberModel.find({ projectId }).sort({ createdAt: 1 }).lean();
  const users = await UserModel.find({ _id: { $in: members.map((member) => member.userId) } }).select({ name: 1, email: 1 }).lean();
  const byId = new Map(users.map((member) => [String(member._id), { name: member.name, email: member.email }]));
  return NextResponse.json({ owner: { userId: access.project.userId, role: "owner" }, members: members.map((member) => ({ ...member, user: byId.get(member.userId) ?? null })) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canManageMembers(access.role)) return apiError("FORBIDDEN", 403, "只有项目所有者可以管理成员");
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "成员邀请格式不正确");
  const target = await UserModel.findOne({ email: parsed.data.email.toLowerCase(), status: "active" }).select({ _id: 1, name: 1, email: 1 }).lean();
  if (!target) return apiError("USER_NOT_FOUND", 404, "找不到可加入项目的用户");
  const targetId = String(target._id);
  if (targetId === access.project.userId) return apiError("ALREADY_OWNER", 409, "该用户已经是项目所有者");
  const member = await ProjectMemberModel.findOneAndUpdate(
    { projectId, userId: targetId },
    { $set: { role: parsed.data.role }, $setOnInsert: { memberId: `pm_${randomUUID().replaceAll("-", "").slice(0, 20)}`, projectId, workspaceId: access.project.workspaceId, userId: targetId, invitedBy: user.id } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return NextResponse.json({ member: { ...member, user: { name: target.name, email: target.email } } }, { status: 201, headers: { "cache-control": "no-store" } });
}
