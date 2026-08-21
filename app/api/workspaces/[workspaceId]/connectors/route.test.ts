import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspace: vi.fn(),
  createWorkspaceConnector: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/workspaces", () => ({ getWorkspace: mocks.getWorkspace }));
vi.mock("@/lib/workspace-connectors", () => ({ createWorkspaceConnector: mocks.createWorkspaceConnector, listWorkspaceConnectors: vi.fn() }));

import { POST } from "@/app/api/workspaces/[workspaceId]/connectors/route";

describe("workspace connector creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.getWorkspace.mockResolvedValue({ connectorIds: [] });
    mocks.createWorkspaceConnector.mockResolvedValue({ id: "mcp_1", name: "Legacy server", transport: "sse", url: "https://mcp.example.com/sse", status: "untested", lastCheckedAt: null, lastError: null });
  });

  it("accepts the legacy SSE MCP transport without changing it", async () => {
    const request = new NextRequest("http://localhost/api/workspaces/ws_1/connectors", {
      method: "POST",
      body: JSON.stringify({ name: "Legacy server", transport: "sse", url: "https://mcp.example.com/sse", headers: { authorization: "Bearer private" } }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request, { params: Promise.resolve({ workspaceId: "ws_1" }) });

    expect(response).toBeDefined();
    const created = response!;
    expect(created.status).toBe(201);
    expect(mocks.createWorkspaceConnector).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      workspaceId: "ws_1",
      transport: "sse",
      url: "https://mcp.example.com/sse",
    }));
    expect(await created.json()).toMatchObject({ connector: { transport: "sse", enabled: true } });
  });
});
