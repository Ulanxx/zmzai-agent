import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { unauthenticated } from "@/lib/api-error";
import { defaultStore } from "@/framework/core/runtime/runner";
import { FrameworkMessageModel, FrameworkPartModel } from "@/framework/core/session/mongo-models";
import { WorkspaceModel } from "@/models/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cross-session audit list (FW 协议): one row per framework session with its
 *  tool-call tally and latest status, replacing the legacy TaskRun audit.
 *  Messages/parts are read in two batched queries across all sessions (not
 *  one getMessages round-trip per session — that grows linearly and stalls
 *  once the session count climbs). */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId") ?? undefined;

  const sessions = await defaultStore.listSessions({ userId: user.id, ...(workspaceId ? { workspaceId } : {}) });
  const sessionIds = sessions.map((session) => session.id);
  const workspaceIds = [...new Set(sessions.map((session) => session.workspaceId))];
  const [workspaces, allMessages, allParts] = await Promise.all([
    WorkspaceModel.find({ userId: user.id, workspaceId: { $in: workspaceIds } }).select({ workspaceId: 1, name: 1 }).lean(),
    sessionIds.length ? FrameworkMessageModel.find({ sessionId: { $in: sessionIds } }).select({ sessionId: 1, info: 1 }).lean() : Promise.resolve([]),
    sessionIds.length ? FrameworkPartModel.find({ sessionId: { $in: sessionIds } }).select({ sessionId: 1, part: 1 }).lean() : Promise.resolve([]),
  ]);
  const workspaceName = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.name]));

  const messagesBySession = new Map<string, Array<{ time?: { created?: string } }>>();
  for (const record of allMessages) {
    const list = messagesBySession.get(record.sessionId) ?? [];
    list.push(record.info);
    messagesBySession.set(record.sessionId, list);
  }
  const toolPartsBySession = new Map<string, number>();
  const failedToolsBySession = new Map<string, number>();
  for (const record of allParts) {
    const part = record.part;
    if (!part || part.type !== "tool") continue;
    toolPartsBySession.set(record.sessionId, (toolPartsBySession.get(record.sessionId) ?? 0) + 1);
    if (part.state && part.state.status === "error") failedToolsBySession.set(record.sessionId, (failedToolsBySession.get(record.sessionId) ?? 0) + 1);
  }

  const rows = sessions.map((session) => {
    const messages = messagesBySession.get(session.id) ?? [];
    const lastActivity = messages.at(-1)?.time?.created ?? session.time.updated;
    return {
      sessionId: session.id,
      title: session.title,
      workspace: workspaceName.get(session.workspaceId) ?? session.workspaceId,
      agent: session.agent,
      model: session.model.modelId,
      toolCalls: toolPartsBySession.get(session.id) ?? 0,
      failedTools: failedToolsBySession.get(session.id) ?? 0,
      updatedAt: session.time.updated,
      lastActivity,
    };
  });

  return NextResponse.json({ sessions: rows }, { headers: { "cache-control": "no-store" } });
}
