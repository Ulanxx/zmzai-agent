import { describe, expect, it } from "vitest";

import { isPublicConnectorAddress, normalizeConnectorUrl } from "@/lib/workspace-connectors";

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
