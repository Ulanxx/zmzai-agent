import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { agentApiScopes, createAgentApiKey } from "@/lib/agent-api-keys";
import { getCurrentUser } from "@/lib/auth/session";
import { getWorkspace } from "@/lib/workspaces";
import { AgentApiKeyModel } from "@/models/agent-api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  workspaceIds: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
  scopes: z.array(z.enum(agentApiScopes)).min(1).max(agentApiScopes.length),
}).strict().refine((value) => new Set(value.workspaceIds).size === value.workspaceIds.length, { message: "Workspace 不能重复", path: ["workspaceIds"] })
  .refine((value) => new Set(value.scopes).size === value.scopes.length, { message: "权限不能重复", path: ["scopes"] });

function summary(record: { agentApiKeyId: string; prefix: string; name: string; workspaceIds: string[]; scopes: string[]; status: string; lastUsedAt?: Date | null; revokedAt?: Date | null; createdAt: Date }) {
  return { id: record.agentApiKeyId, prefix: record.prefix, name: record.name, workspaceIds: record.workspaceIds, scopes: record.scopes, status: record.status, lastUsedAt: record.lastUsedAt?.toISOString() ?? null, revokedAt: record.revokedAt?.toISOString() ?? null, createdAt: record.createdAt.toISOString() };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const keys = await AgentApiKeyModel.find({ userId: user.id }).sort({ createdAt: -1 }).limit(100).lean();
  return NextResponse.json({ keys: keys.map(summary) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "API Key 请求格式不正确");
  const ownership = await Promise.all(parsed.data.workspaceIds.map((workspaceId) => getWorkspace(user.id, workspaceId)));
  if (ownership.some((workspace) => !workspace)) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  const created = await createAgentApiKey({ userId: user.id, ...parsed.data });
  return NextResponse.json({ key: created.key, record: summary(created.record) }, { status: 201, headers: { "cache-control": "no-store" } });
}
