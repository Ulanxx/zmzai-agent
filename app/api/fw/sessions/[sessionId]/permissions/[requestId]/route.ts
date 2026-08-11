import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const replySchema = z
  .object({
    reply: z.enum(["once", "always", "reject"]),
    feedback: z.string().trim().max(2_000).optional(),
  })
  .strict();

export async function POST(request: NextRequest, context: { params: Promise<{ sessionId: string; requestId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId, requestId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session || session.userId !== user.id) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");

  const parsed = replySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "审批请求格式不正确");

  const resolved = await getFrameworkRunner().replyPermission(sessionId, requestId, parsed.data.reply, parsed.data.feedback);
  if (!resolved) return apiError("PERMISSION_REQUEST_NOT_FOUND", 404, "审批请求不存在或已处理");
  return NextResponse.json({ resolved: true }, { headers: { "cache-control": "no-store" } });
}
