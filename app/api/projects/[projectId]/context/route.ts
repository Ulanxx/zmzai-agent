import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { ProjectContextItemModel } from "@/models/project-context-item";
import { canEditProject, getProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  type: z.enum(["note", "link"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().max(64 * 1024).optional().default(""),
  url: z.string().trim().url().max(2_000).optional().default(""),
}).strict().superRefine((value, context) => {
  if (value.type === "note" && !value.content.trim()) context.addIssue({ code: "custom", path: ["content"], message: "笔记内容不能为空" });
  if (value.type === "link" && !value.url) context.addIssue({ code: "custom", path: ["url"], message: "链接不能为空" });
});

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  if (!(await getProjectAccess(projectId, user.id))) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  const items = await ProjectContextItemModel.find({ projectId }).sort({ createdAt: -1 }).lean();
  return NextResponse.json({ contextItems: items }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  if (!canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能编辑项目上下文");
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "项目上下文格式不正确");
  const item = await ProjectContextItemModel.create({ contextId: `ctx_${randomUUID().replaceAll("-", "").slice(0, 20)}`, projectId, workspaceId: access.project.workspaceId, userId: access.project.userId, ...parsed.data });
  return NextResponse.json({ contextItem: item }, { status: 201, headers: { "cache-control": "no-store" } });
}
