import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getWorkspace } from "@/lib/workspaces";
import { addGithubWorkspacePlugin, listWorkspacePlugins } from "@/lib/workspace-plugins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const importSchema = z.object({
  repository: z.string().trim().min(3).max(256),
  ref: z.string().trim().min(1).max(256).default("main"),
  path: z.string().trim().max(512).default(""),
}).strict();

async function identity(context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return { error: unauthenticated() } as const;
  const { workspaceId } = await context.params;
  if (!(await getWorkspace(user.id, workspaceId))) return { error: apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问") } as const;
  return { user, workspaceId } as const;
}

export async function GET(_: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const auth = await identity(context);
  if ("error" in auth) return auth.error;
  return NextResponse.json({ plugins: await listWorkspacePlugins({ userId: auth.user.id, workspaceId: auth.workspaceId }) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const auth = await identity(context);
  if ("error" in auth) return auth.error;
  const parsed = importSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Agent Plugin 请求格式不正确");
  try {
    const result = await addGithubWorkspacePlugin({ userId: auth.user.id, workspaceId: auth.workspaceId, ...parsed.data });
    return NextResponse.json(result, { status: result.reused ? 200 : 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError("AGENT_PLUGIN_IMPORT_FAILED", 422, error instanceof Error ? error.message : "Agent Plugin 导入失败");
  }
}
