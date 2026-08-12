import { NextResponse } from "next/server";

import { getServerEnvironment } from "@/config/env";
import { createLocalDevSession, isLocalDevLoginEnabled, localDevSessionTtlSeconds } from "@/lib/auth/local-dev-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isLocalDevLoginEnabled()) return new NextResponse("Not Found", { status: 404 });

  const environment = getServerEnvironment();
  const session = await createLocalDevSession();
  const response = NextResponse.redirect(new URL("/fw", request.url), 303);
  response.cookies.set(environment.SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: localDevSessionTtlSeconds,
    expires: session.expiresAt,
  });
  return response;
}
