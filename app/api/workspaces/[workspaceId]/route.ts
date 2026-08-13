import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { deleteWorkspace, getWorkspace, updateWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  prompt: z.string().max(64 * 1024).optional(),
  steps: z.number().int().min(1).max(64).optional(),
  defaultModel: z.string().trim().max(160).optional(),
}).strict();

export async function GET(_: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  const workspace = await getWorkspace(user.id, workspaceId);
  if (!workspace) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在");
  return NextResponse.json({ workspace }, { headers: { "cache-control": "no-store" } });
}

/** 重命名 / 更新描述。 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Workspace 更新请求格式不正确");
  const workspace = await updateWorkspace(user.id, workspaceId, parsed.data);
  if (!workspace) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在");
  return NextResponse.json({ workspace }, { headers: { "cache-control": "no-store" } });
}

/** 删除 Workspace（级联删除会话/产物/文件版本等全部关联数据，不可恢复）。 */
export async function DELETE(_: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  const deleted = await deleteWorkspace(user.id, workspaceId);
  if (!deleted) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在");
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
