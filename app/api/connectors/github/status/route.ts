import { NextRequest, NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { githubOauthConfigured } from "@/lib/github-oauth";
import { getWorkspace } from "@/lib/workspaces";
import { WorkspaceConnectorModel } from "@/models/workspace-connector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  if (!workspaceId || !(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  const connector = await WorkspaceConnectorModel.findOne({ userId: user.id, workspaceId, transport: "github" }).select({ connectorId: 1, status: 1, lastError: 1 }).lean();
  return NextResponse.json({ configured: githubOauthConfigured(), connected: Boolean(connector), connector: connector ? { id: connector.connectorId, status: connector.status, lastError: connector.lastError ?? null } : null }, { headers: { "cache-control": "no-store" } });
}
