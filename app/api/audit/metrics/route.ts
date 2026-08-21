import { NextRequest, NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { readProductMetrics } from "@/lib/product-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  if (user.role !== "admin") return apiError("FORBIDDEN", 403, "仅管理员可以查看产品指标");
  const days = Math.min(90, Math.max(1, Number.parseInt(request.nextUrl.searchParams.get("days") ?? "30", 10) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return NextResponse.json({ since: since.toISOString(), days, metrics: await readProductMetrics(since) }, { headers: { "cache-control": "no-store" } });
}
