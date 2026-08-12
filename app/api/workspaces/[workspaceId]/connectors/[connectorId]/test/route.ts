import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getWorkspace } from "@/lib/workspaces";
import { testWorkspaceConnector } from "@/lib/workspace-connectors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_: NextRequest, context: { params: Promise<{ workspaceId: string; connectorId: string }> }) { const user = await getCurrentUser(); if (!user) return unauthenticated(); const { workspaceId, connectorId } = await context.params; if (!(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问"); const connector = await testWorkspaceConnector({ userId: user.id, workspaceId, connectorId }); if (!connector) return apiError("CONNECTOR_NOT_FOUND", 404, "MCP 连接器不存在或无权访问"); return NextResponse.json({ connector }, { headers: { "cache-control": "no-store" } }); }
