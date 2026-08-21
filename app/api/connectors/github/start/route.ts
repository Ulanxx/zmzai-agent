import { NextRequest, NextResponse } from "next/server";

import { getServerEnvironment } from "@/config/env";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { createGithubOauthState, githubAuthorizationUrl, githubOauthConfigured } from "@/lib/github-oauth";
import { getWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stateCookie = "zmzai_github_oauth_state";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  if (!workspaceId || !(await getWorkspace(user.id, workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  if (!githubOauthConfigured()) return apiError("GITHUB_OAUTH_NOT_CONFIGURED", 503, "GitHub OAuth 尚未配置");
  const state = createGithubOauthState(workspaceId);
  const response = NextResponse.redirect(githubAuthorizationUrl(state), 302);
  response.cookies.set(stateCookie, state, {
    httpOnly: true,
    secure: getServerEnvironment().NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/connectors/github",
    maxAge: 10 * 60,
  });
  return response;
}
