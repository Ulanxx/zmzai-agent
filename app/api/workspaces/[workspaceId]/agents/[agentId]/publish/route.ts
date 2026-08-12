import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { publishAgentDraft } from "@/lib/agents";
import { getWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_: NextRequest, context: { params: Promise<{ workspaceId: string; agentId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId, agentId } = await context.params;
  if (!(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  const detail = await publishAgentDraft({ userId: user.id, workspaceId, agentId });
  if (!detail) return apiError("AGENT_NOT_FOUND", 404, "Agent 不存在或无权访问");
  return NextResponse.json(detail, { headers: { "cache-control": "no-store" } });
}
