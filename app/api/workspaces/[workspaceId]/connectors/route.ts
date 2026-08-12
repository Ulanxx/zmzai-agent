import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getWorkspace } from "@/lib/workspaces";
import { createWorkspaceConnector, listWorkspaceConnectors } from "@/lib/workspace-connectors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const connectorSchema = z.object({
  name: z.string().trim().min(1).max(96),
  transport: z.enum(["streamable-http", "sse"]),
  url: z.string().trim().url().max(2_000),
  headers: z.record(z.string().trim().min(1).max(128), z.string().max(4_096)).default({}),
}).strict().refine((value) => Object.keys(value.headers).length <= 32, { message: "最多配置 32 个 Header", path: ["headers"] });
async function identity(context: { params: Promise<{ workspaceId: string }> }) { const user = await getCurrentUser(); if (!user) return { error: unauthenticated() } as const; const { workspaceId } = await context.params; if (!(await getWorkspace(user.id, workspaceId))) return { error: apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问") } as const; return { user, workspaceId } as const; }
export async function GET(_: NextRequest, context: { params: Promise<{ workspaceId: string }> }) { const auth = await identity(context); if ("error" in auth) return auth.error; return NextResponse.json({ connectors: await listWorkspaceConnectors({ userId: auth.user.id, workspaceId: auth.workspaceId }) }, { headers: { "cache-control": "no-store" } }); }
export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) { const auth = await identity(context); if ("error" in auth) return auth.error; const parsed = connectorSchema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return apiError("INVALID_BODY", 400, "MCP 连接器请求格式不正确"); try { return NextResponse.json({ connector: await createWorkspaceConnector({ userId: auth.user.id, workspaceId: auth.workspaceId, ...parsed.data }) }, { status: 201, headers: { "cache-control": "no-store" } }); } catch (error) { return apiError("CONNECTOR_CREATE_FAILED", 422, error instanceof Error ? error.message : "无法创建 MCP 连接器"); } }
