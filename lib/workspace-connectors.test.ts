import { describe, expect, it } from "vitest";

import { isGithubUserResponse, isMcpInitializeResponse, isPublicConnectorAddress, normalizeConnectorUrl, parseMcpInitializePayload } from "@/lib/workspace-connectors";

describe("normalizeConnectorUrl", () => {
  it("allows only HTTPS connector endpoints", () => {
    expect(normalizeConnectorUrl("https://mcp.example.com/service")).toBe("https://mcp.example.com/service");
    expect(normalizeConnectorUrl("http://localhost:3000/mcp")).toBeNull();
    expect(normalizeConnectorUrl("not-a-url")).toBeNull();
  });
});

describe("isPublicConnectorAddress", () => {
  it("rejects loopback, private, and link-local addresses used in SSRF probes", () => {
    expect(isPublicConnectorAddress("127.0.0.1")).toBe(false);
    expect(isPublicConnectorAddress("10.1.2.3")).toBe(false);
    expect(isPublicConnectorAddress("169.254.169.254")).toBe(false);
    expect(isPublicConnectorAddress("::1")).toBe(false);
    expect(isPublicConnectorAddress("fd00::1")).toBe(false);
    expect(isPublicConnectorAddress("8.8.8.8")).toBe(true);
  });
});

describe("isMcpInitializeResponse", () => {
  it("requires a successful JSON-RPC initialize result instead of any HTTP 200 body", () => {
    expect(isMcpInitializeResponse({ jsonrpc: "2.0", id: "1", result: { protocolVersion: "2024-11-05" } })).toBe(true);
    expect(isMcpInitializeResponse({ ok: true })).toBe(false);
    expect(isMcpInitializeResponse({ jsonrpc: "2.0", error: { message: "nope" } })).toBe(false);
  });
});

describe("isGithubUserResponse", () => {
  it("requires the authenticated user shape returned by GitHub", () => {
    expect(isGithubUserResponse({ login: "octocat", id: 1 })).toBe(true);
    expect(isGithubUserResponse({ message: "Bad credentials" })).toBe(false);
    expect(isGithubUserResponse({ login: "" })).toBe(false);
  });
});

describe("parseMcpInitializePayload", () => {
  it("accepts the SSE response form used by Streamable HTTP MCP servers", () => {
    const payload = parseMcpInitializePayload("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{\"protocolVersion\":\"2024-11-05\"}}\n\n", true);
    expect(isMcpInitializeResponse(payload)).toBe(true);
  });

  it("rejects an SSE response without a JSON-RPC data message", () => {
    expect(() => parseMcpInitializePayload("event: ping\n\n", true)).toThrow("MCP initialize 未返回 JSON-RPC 响应");
  });
});
