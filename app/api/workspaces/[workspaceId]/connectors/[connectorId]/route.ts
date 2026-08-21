import { NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { deleteWorkspaceConnector } from "@/lib/workspace-connectors";
import { getWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_: Request, context: { params: Promise<{ workspaceId: string; connectorId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId, connectorId } = await context.params;
  if (!(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  if (!(await deleteWorkspaceConnector({ userId: user.id, workspaceId, connectorId }))) return apiError("CONNECTOR_NOT_FOUND", 404, "连接器不存在或无权访问");
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
