import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { listWorkspaceFiles } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  const files = await listWorkspaceFiles(user.id, workspaceId);
  if (!files) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在");
  return NextResponse.json({ files }, { headers: { "cache-control": "no-store" } });
}
