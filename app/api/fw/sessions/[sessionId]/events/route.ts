import { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { subscribeFrameworkEvents } from "@/framework/core/events/bus";
import { defaultStore } from "@/framework/core/runtime/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SSE stream (spec §4.3): replays durable events with seq > since, then
 *  follows live. The stream closes when the client aborts. */
export async function GET(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("UNAUTHENTICATED", { status: 401 });
  const { sessionId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session || session.userId !== user.id) return new Response("SESSION_NOT_FOUND", { status: 404 });

  const sinceParam = request.nextUrl.searchParams.get("since");
  const sinceSeq = sinceParam ? Number.parseInt(sinceParam, 10) : 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: string) => {
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // client disconnected mid-write
        }
      };
      try {
        for await (const event of subscribeFrameworkEvents(sessionId, { sinceSeq: Number.isNaN(sinceSeq) ? 0 : sinceSeq, signal: request.signal })) {
          send(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, _seq: event.seq, _at: event.at })}\n\n`);
        }
      } catch {
        // subscription failed (abort or store error) — close the stream
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
