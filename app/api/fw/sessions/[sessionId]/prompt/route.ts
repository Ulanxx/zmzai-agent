import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const promptSchema = z
  .object({
    text: z.string().trim().min(1).max(32 * 1024),
    agent: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export async function POST(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session || session.userId !== user.id) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");

  const parsed = promptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "prompt 请求格式不正确");

  const result = await getFrameworkRunner().prompt(sessionId, {
    text: parsed.data.text,
    ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
  });
  return NextResponse.json({ accepted: true, queued: result.queued }, { status: 202, headers: { "cache-control": "no-store" } });
}
