import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { createWorkspace, getWorkspace, listWorkspaces } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(""),
  defaultModel: z.string().trim().min(1).max(160),
}).strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  return NextResponse.json({ workspaces: await listWorkspaces(user.id) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createWorkspaceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Workspace 请求格式不正确");

  try {
    const claim = await claimIdempotency({
      userId: user.id,
      scope: "workspace.create",
      key: request.headers.get("idempotency-key"),
      body: parsed.data,
      resourceId: `ws_${randomUUID()}`,
    });
    if (claim.replayed) {
      const workspace = await getWorkspace(user.id, claim.resourceId);
      if (workspace) return NextResponse.json({ workspace, replayed: true }, { headers: { "cache-control": "no-store" } });
      const recoveredWorkspace = await createWorkspace({ userId: user.id, ...parsed.data, workspaceId: claim.resourceId });
      return NextResponse.json({ workspace: recoveredWorkspace, replayed: true }, { status: 201, headers: { "cache-control": "no-store" } });
    }

    const workspace = await createWorkspace({ userId: user.id, ...parsed.data, workspaceId: claim.resourceId });
    return NextResponse.json({ workspace }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
