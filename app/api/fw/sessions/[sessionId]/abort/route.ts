import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session || session.userId !== user.id) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");
  await getFrameworkRunner().abort(sessionId);
  return NextResponse.json({ aborted: true }, { headers: { "cache-control": "no-store" } });
}
