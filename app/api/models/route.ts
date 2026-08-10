import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { listRelayAgentModels } from "@/lib/relay-agent-models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  try {
    return NextResponse.json({ models: await listRelayAgentModels(user.id) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError("RELAY_MODELS_UNAVAILABLE", 503, error instanceof Error ? error.message : "模型目录暂时不可用");
  }
}
