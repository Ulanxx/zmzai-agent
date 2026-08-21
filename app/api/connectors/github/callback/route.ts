import { NextRequest, NextResponse } from "next/server";

import { getServerEnvironment } from "@/config/env";
import { getCurrentUser } from "@/lib/auth/session";
import { createGithubWorkspaceConnector } from "@/lib/workspace-connectors";
import { exchangeGithubCode, githubWorkspaceFromState } from "@/lib/github-oauth";
import { getWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stateCookie = "zmzai_github_oauth_state";

function resultRedirect(request: NextRequest, status: "connected" | "error"): NextResponse {
  const destination = new URL("/connectors", request.url);
  destination.searchParams.set("github", status);
  const response = NextResponse.redirect(destination, 303);
  response.cookies.set(stateCookie, "", { httpOnly: true, secure: getServerEnvironment().NODE_ENV === "production", sameSite: "lax", path: "/api/connectors/github", maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const code = request.nextUrl.searchParams.get("code")?.trim();
  const state = request.nextUrl.searchParams.get("state")?.trim();
  const storedState = request.cookies.get(stateCookie)?.value;
  if (!user || !code || !state || !storedState || state !== storedState) return resultRedirect(request, "error");
  const workspaceId = githubWorkspaceFromState(state);
  if (!workspaceId || !(await getWorkspace(user.id, workspaceId))) return resultRedirect(request, "error");
  try {
    const accessToken = await exchangeGithubCode(code);
    await createGithubWorkspaceConnector({ userId: user.id, workspaceId, accessToken });
    return resultRedirect(request, "connected");
  } catch {
    return resultRedirect(request, "error");
  }
}
