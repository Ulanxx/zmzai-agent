import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getAgentDetail, updateAgentDraft } from "@/lib/agents";
import { getWorkspace } from "@/lib/workspaces";
import { workspaceOwnsSkillIds } from "@/lib/workspace-skills";
import { workspaceOwnsPluginIds } from "@/lib/workspace-plugins";
import { workspaceOwnsConnectorIds } from "@/lib/workspace-connectors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const draftSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(2_000).default(""),
  icon: z.string().trim().min(1).max(64).default("spark"),
  prompt: z.string().max(64 * 1024).default(""),
  model: z.object({ providerId: z.string().trim().min(1).max(64), modelId: z.string().trim().min(1).max(160) }).nullable().default(null),
  steps: z.number().int().min(1).max(64).default(12),
  tools: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  pluginIds: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
  skillIds: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
  connectorIds: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
}).strict();

async function identity(context: { params: Promise<{ workspaceId: string; agentId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return { error: unauthenticated() } as const;
  const { workspaceId, agentId } = await context.params;
  if (!(await getWorkspace(user.id, workspaceId))) return { error: apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问") } as const;
  return { user, workspaceId, agentId } as const;
}

export async function GET(_: NextRequest, context: { params: Promise<{ workspaceId: string; agentId: string }> }) {
  const auth = await identity(context);
  if ("error" in auth) return auth.error;
  const detail = await getAgentDetail({ userId: auth.user.id, workspaceId: auth.workspaceId, agentId: auth.agentId });
  if (!detail) return apiError("AGENT_NOT_FOUND", 404, "Agent 不存在或无权访问");
  return NextResponse.json(detail, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ workspaceId: string; agentId: string }> }) {
  const auth = await identity(context);
  if ("error" in auth) return auth.error;
  const parsed = draftSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Agent 草稿格式不正确");
  const current = await getAgentDetail({ userId: auth.user.id, workspaceId: auth.workspaceId, agentId: auth.agentId });
  if (!current) return apiError("AGENT_NOT_FOUND", 404, "Agent 不存在或无权访问");
  const body = parsed.data;
  if (!(await workspaceOwnsSkillIds({ userId: auth.user.id, workspaceId: auth.workspaceId, skillIds: body.skillIds }))) {
    return apiError("SKILL_NOT_FOUND", 422, "Skill 不存在或不属于当前 Workspace");
  }
  if (!(await workspaceOwnsPluginIds({ userId: auth.user.id, workspaceId: auth.workspaceId, pluginIds: body.pluginIds }))) {
    return apiError("PLUGIN_NOT_FOUND", 422, "Agent Plugin 不存在或不属于当前 Workspace");
  }
  if (!(await workspaceOwnsConnectorIds({ userId: auth.user.id, workspaceId: auth.workspaceId, connectorIds: body.connectorIds }))) {
    return apiError("CONNECTOR_NOT_FOUND", 422, "MCP 连接器不存在或不属于当前 Workspace");
  }
  const agentWithoutModel = { ...current.draft.agent };
  delete agentWithoutModel.model;
  const detail = await updateAgentDraft({
    userId: auth.user.id,
    workspaceId: auth.workspaceId,
    agentId: auth.agentId,
    name: body.name,
    description: body.description,
    icon: body.icon,
    draft: {
      agent: {
        ...agentWithoutModel,
        description: body.description || body.name,
        prompt: body.prompt,
        steps: body.steps,
        ...(body.model ? { model: body.model } : {}),
      },
      capabilities: {
        tools: body.tools,
        pluginIds: body.pluginIds,
        skillIds: body.skillIds,
        connectorIds: body.connectorIds,
      },
    },
  });
  if (!detail) return apiError("AGENT_NOT_FOUND", 404, "Agent 不存在或无权访问");
  return NextResponse.json(detail, { headers: { "cache-control": "no-store" } });
}
