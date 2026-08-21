import { NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { AgentApiKeyModel } from "@/models/agent-api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_: Request, context: { params: Promise<{ keyId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { keyId } = await context.params;
  const result = await AgentApiKeyModel.updateOne({ agentApiKeyId: keyId, userId: user.id, status: "active" }, { $set: { status: "revoked", revokedAt: new Date() } });
  if (!result.matchedCount) return apiError("API_KEY_NOT_FOUND", 404, "API Key 不存在或已撤销");
  return NextResponse.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
}
