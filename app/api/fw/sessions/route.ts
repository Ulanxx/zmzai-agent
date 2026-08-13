import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { createFrameworkSession } from "@/framework/core/runtime/runner";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { getWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSessionSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(64),
    model: z.object({ providerId: z.string().trim().min(1).max(64), modelId: z.string().trim().min(1).max(160) }),
    prompt: z.string().trim().min(1).max(32 * 1024).optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId") ?? undefined;
  const sessions = await defaultStore.listSessions({ userId: user.id, ...(workspaceId ? { workspaceId } : {}) });
  return NextResponse.json({ sessions }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createSessionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "会话请求格式不正确");

  const workspace = await getWorkspace(user.id, parsed.data.workspaceId);
  if (!workspace) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");

  // Workspace = 智能体：session 绑定 workspace，配置从 workspace 实时读（agentResolver）。
  const session = await createFrameworkSession({
    store: defaultStore,
    userId: user.id,
    workspaceId: parsed.data.workspaceId,
    agent: workspace.name,
    model: parsed.data.model,
    ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}),
  });

  if (parsed.data.prompt) {
    await getFrameworkRunner().prompt(session.id, { text: parsed.data.prompt });
  }
  return NextResponse.json({ session }, { status: 201, headers: { "cache-control": "no-store" } });
}
