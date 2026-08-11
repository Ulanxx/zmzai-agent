import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { unauthenticated } from "@/lib/api-error";
import { getFrameworkRegistry } from "@/framework/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const agents = getFrameworkRegistry().list().map((agent) => ({
    name: agent.name,
    description: agent.description ?? "",
    mode: agent.mode,
  }));
  return NextResponse.json({ agents }, { headers: { "cache-control": "no-store" } });
}
