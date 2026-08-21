import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { readFrameworkEvents } from "@/framework/core/events/bus";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getSessionProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session || (session.userId !== user.id && !(await getSessionProjectAccess(sessionId, user.id)))) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");
  const [messages, events] = await Promise.all([defaultStore.getMessages(sessionId), readFrameworkEvents(sessionId, 0, 5_000)]);
  return NextResponse.json({ session, messages, events }, { headers: { "cache-control": "no-store" } });
}
