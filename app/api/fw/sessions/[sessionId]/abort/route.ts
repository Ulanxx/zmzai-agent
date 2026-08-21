import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { cancelRunForSession } from "@/lib/task-run-control";
import { canRunProject, getSessionProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  const access = session?.userId === user.id ? null : session ? await getSessionProjectAccess(sessionId, user.id) : null;
  if (!session || (session.userId !== user.id && (!access || !canRunProject(access.role)))) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");
  const run = await cancelRunForSession(sessionId);
  await getFrameworkRunner().abort(sessionId);
  return NextResponse.json({ aborted: true, run }, { headers: { "cache-control": "no-store" } });
}
