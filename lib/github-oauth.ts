import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getServerEnvironment } from "@/config/env";

type GithubOauthConfig = { clientId: string; clientSecret: string; callbackUrl: string };

function config(): GithubOauthConfig {
  const environment = getServerEnvironment();
  if (!environment.GITHUB_OAUTH_CLIENT_ID || !environment.GITHUB_OAUTH_CLIENT_SECRET) throw new Error("GitHub OAuth 尚未配置");
  return { clientId: environment.GITHUB_OAUTH_CLIENT_ID, clientSecret: environment.GITHUB_OAUTH_CLIENT_SECRET, callbackUrl: new URL("/api/connectors/github/callback", environment.APP_URL).toString() };
}

function sign(payload: string): string {
  return createHmac("sha256", getServerEnvironment().AUTH_SECRET).update(payload).digest("base64url");
}

export function githubOauthConfigured(): boolean {
  const environment = getServerEnvironment();
  return Boolean(environment.GITHUB_OAUTH_CLIENT_ID && environment.GITHUB_OAUTH_CLIENT_SECRET);
}

export function createGithubOauthState(workspaceId: string): string {
  const payload = Buffer.from(JSON.stringify({ workspaceId, nonce: randomBytes(18).toString("base64url") })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function githubWorkspaceFromState(state: string): string | null {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const receivedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return value && typeof value === "object" && "workspaceId" in value && typeof value.workspaceId === "string" && value.workspaceId.length > 0 ? value.workspaceId : null;
  } catch {
    return null;
  }
}

export function githubAuthorizationUrl(state: string): string {
  const settings = config();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", settings.callbackUrl);
  url.searchParams.set("scope", "read:user repo");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGithubCode(code: string): Promise<string> {
  const settings = config();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: settings.clientId, client_secret: settings.clientSecret, code, redirect_uri: settings.callbackUrl }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null) as { access_token?: unknown; error_description?: unknown } | null;
  if (!response.ok || !body || typeof body.access_token !== "string" || !body.access_token) throw new Error(typeof body?.error_description === "string" ? body.error_description : "GitHub 授权交换失败");
  return body.access_token;
}
