import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  const workspace = await getWorkspace(user.id, workspaceId);
  if (!workspace) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在");
  return NextResponse.json({ workspace }, { headers: { "cache-control": "no-store" } });
}
