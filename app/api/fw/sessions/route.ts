import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { createFrameworkSession } from "@/framework/core/runtime/runner";
import { defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { getWorkspace } from "@/lib/workspaces";
import { ensureDefaultAgent, getPublishedAgentVersion } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSessionSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(64),
    agent: z.string().trim().min(1).max(64).optional(),
    agentId: z.string().trim().min(1).max(96).optional(),
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
  const fallback = await ensureDefaultAgent({ userId: user.id, workspaceId: workspace.id });
  const version = await getPublishedAgentVersion({ userId: user.id, workspaceId: workspace.id, ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}) });
  if (!version && parsed.data.agentId) return apiError("AGENT_NOT_FOUND", 404, "Agent 不存在、未发布或无权使用");
  const selected = version ?? fallback?.version;
  if (!selected) return apiError("DEFAULT_AGENT_UNAVAILABLE", 409, "项目默认 Agent 不可用");

  const session = await createFrameworkSession({
    store: defaultStore,
    userId: user.id,
    workspaceId: parsed.data.workspaceId,
    agent: selected.agent.name,
    agentId: selected.agentId,
    agentVersionId: selected.id,
    model: parsed.data.model,
    ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}),
  });

  if (parsed.data.prompt) {
    await getFrameworkRunner().prompt(session.id, { text: parsed.data.prompt });
  }
  return NextResponse.json({ session }, { status: 201, headers: { "cache-control": "no-store" } });
}
