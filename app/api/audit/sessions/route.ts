import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { unauthenticated } from "@/lib/api-error";
import { defaultStore } from "@/framework/core/runtime/runner";
import { WorkspaceModel } from "@/models/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cross-session audit list (FW 协议): one row per framework session with its
 *  tool-call tally and latest status, replacing the legacy TaskRun audit. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId") ?? undefined;

  const sessions = await defaultStore.listSessions({ userId: user.id, ...(workspaceId ? { workspaceId } : {}) });
  const workspaceIds = [...new Set(sessions.map((session) => session.workspaceId))];
  const workspaces = await WorkspaceModel.find({ userId: user.id, workspaceId: { $in: workspaceIds } }).select({ workspaceId: 1, name: 1 }).lean();
  const workspaceName = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.name]));

  // Tool-call tally per session from persisted parts.
  const rows = await Promise.all(
    sessions.map(async (session) => {
      const messages = await defaultStore.getMessages(session.id);
      const parts = messages.flatMap((entry) => entry.parts);
      const toolParts = parts.filter((part) => part.type === "tool");
      const failed = toolParts.filter((part) => part.type === "tool" && part.state.status === "error").length;
      const lastActivity = messages.at(-1)?.info.time.created ?? session.time.updated;
      return {
        sessionId: session.id,
        title: session.title,
        workspace: workspaceName.get(session.workspaceId) ?? session.workspaceId,
        agent: session.agent,
        model: session.model.modelId,
        toolCalls: toolParts.length,
        failedTools: failed,
        updatedAt: session.time.updated,
        lastActivity,
      };
    }),
  );

  return NextResponse.json({ sessions: rows }, { headers: { "cache-control": "no-store" } });
}
