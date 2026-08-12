import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { createAgent, ensureDefaultAgent, listAgents } from "@/lib/agents";
import { getWorkspace } from "@/lib/workspaces";
import { builtinAgents, rulesetFromConfig, type AgentInfo } from "@zmzai/agent-framework";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(2_000).default(""),
  icon: z.string().trim().min(1).max(64).default("spark"),
  model: z.object({ providerId: z.string().trim().min(1).max(64), modelId: z.string().trim().min(1).max(160) }).optional(),
  prompt: z.string().max(64 * 1024).default(""),
  steps: z.number().int().min(1).max(64).default(12),
  tools: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
}).strict();

export async function GET(_request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  if (!(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "项目不存在或无权访问");
  await ensureDefaultAgent({ userId: user.id, workspaceId });
  return NextResponse.json({ agents: await listAgents(user.id, workspaceId) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { workspaceId } = await context.params;
  if (!(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "项目不存在或无权访问");
  const parsed = createAgentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Agent 请求格式不正确");
  const fallback = builtinAgents.find((agent) => agent.name === "default");
  if (!fallback) return apiError("DEFAULT_AGENT_UNAVAILABLE", 409, "默认 Agent 不可用");
  const body = parsed.data;
  const runtimeAgent: AgentInfo = {
    ...fallback,
    name: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom-agent",
    description: body.description || body.name,
    prompt: body.prompt || fallback.prompt,
    steps: body.steps,
    ...(body.model ? { model: body.model } : {}),
    permission: rulesetFromConfig({ bash: "ask" }),
  };
  const created = await createAgent({
    userId: user.id,
    workspaceId,
    name: body.name,
    description: body.description,
    icon: body.icon,
    agent: runtimeAgent,
    capabilities: { tools: body.tools },
  });
  return NextResponse.json(created, { status: 201, headers: { "cache-control": "no-store" } });
}
