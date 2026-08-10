import { NextResponse } from "next/server";

export function apiError(code: string, status: number, error: string): NextResponse {
  return NextResponse.json({ code, error }, { status, headers: { "cache-control": "no-store" } });
}

export const unauthenticated = () => apiError("UNAUTHENTICATED", 401, "请先登录");
