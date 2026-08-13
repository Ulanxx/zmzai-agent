import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { unauthenticated } from "@/lib/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前登录用户（工作台 header 展示用）。 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  return NextResponse.json({ user: { name: user.name, email: user.email } }, { headers: { "cache-control": "no-store" } });
}
