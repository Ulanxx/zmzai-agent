import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { listTaskEvents } from "@/lib/task-events";
import { getTaskRun } from "@/lib/task-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const terminalStates = new Set(["succeeded", "failed", "cancelled"]);

function afterSequence(header: string | null): number {
  const value = Number.parseInt(header ?? "0", 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function encodeEvent(event: { id: string; type: string; sequence: number; at: string; data: unknown }): Uint8Array {
  return new TextEncoder().encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const userId = user.id;
  const { runId } = await context.params;
  const run = await getTaskRun(userId, runId);
  if (!run) return apiError("RUN_NOT_FOUND", 404, "Task Run 不存在");

  const encoder = new TextEncoder();
  let latest = afterSequence(request.headers.get("last-event-id"));
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      async function flush(): Promise<void> {
        const events = await listTaskEvents(runId, latest);
        for (const event of events) {
          latest = event.sequence;
          controller.enqueue(encodeEvent(event));
        }
        const current = await getTaskRun(userId, runId);
        if (!current || terminalStates.has(current.status)) {
          if (timer) clearInterval(timer);
          controller.close();
        }
      }

      try {
        await flush();
        timer = setInterval(() => { void flush().catch((error: unknown) => controller.error(error)); }, 1_000);
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, { headers: { "cache-control": "no-cache, no-transform", connection: "keep-alive", "content-type": "text/event-stream" } });
}
