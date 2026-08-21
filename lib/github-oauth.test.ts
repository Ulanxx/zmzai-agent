import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvironmentForTest } from "@/config/env";
import { createGithubOauthState, githubAuthorizationUrl, githubWorkspaceFromState } from "@/lib/github-oauth";

const originalEnvironment = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    APP_URL: "https://agent.example.com",
    MONGODB_URI: "mongodb://localhost/test",
    AUTH_SECRET: "a".repeat(64),
    GITHUB_OAUTH_CLIENT_ID: "client_123",
    GITHUB_OAUTH_CLIENT_SECRET: "secret_123",
  });
  resetServerEnvironmentForTest();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetServerEnvironmentForTest();
});

describe("GitHub OAuth", () => {
  it("binds a signed state to its workspace and rejects tampering", () => {
    const state = createGithubOauthState("ws_demo");
    expect(githubWorkspaceFromState(state)).toBe("ws_demo");
    expect(githubWorkspaceFromState(`${state}tampered`)).toBeNull();
    expect(githubWorkspaceFromState(`${state.slice(0, -1)}x`)).toBeNull();
  });

  it("builds a callback URL with the configured read-only scope", () => {
    const url = new URL(githubAuthorizationUrl("state_value"));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client_123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://agent.example.com/api/connectors/github/callback");
    expect(url.searchParams.get("scope")).toBe("read:user repo");
    expect(url.searchParams.get("state")).toBe("state_value");
  });
});
