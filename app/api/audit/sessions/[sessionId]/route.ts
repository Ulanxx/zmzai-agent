import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { readFrameworkEvents } from "@/framework/core/events/bus";
import { defaultStore } from "@/framework/core/runtime/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Audit detail for one FW session: its durable event stream + tool-call
 *  timeline derived from persisted parts. Replaces /api/runs/:id/audit. */
export async function GET(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session || session.userId !== user.id) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");

  const [events, messages] = await Promise.all([readFrameworkEvents(sessionId, 0, 5_000), defaultStore.getMessages(sessionId)]);
  const toolTimeline = messages
    .flatMap((entry) => entry.parts)
    .filter((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool")
    .map((part) => ({
      callId: part.callId,
      tool: part.tool,
      status: part.state.status,
      title: part.state.status === "completed" ? part.state.title : part.state.status === "running" ? (part.state.title ?? null) : null,
      output: part.state.status === "completed" ? part.state.output : part.state.status === "error" ? part.state.error : null,
      startedAt: part.state.status !== "pending" ? part.state.time.start : null,
      endedAt: part.state.status === "completed" || part.state.status === "error" ? part.state.time.end : null,
    }));

  return NextResponse.json(
    {
      session,
      toolTimeline,
      // Strip binary payloads — events carry metadata only by design (spec §9).
      events: events.map((event) => ({ seq: event.seq, type: event.type, at: event.at, data: event.data })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
