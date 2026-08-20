import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace-connectors", () => ({ assertPublicConnectorTarget: vi.fn().mockResolvedValue(undefined) }));

import { StreamableHttpMcpClient } from "@/lib/mcp-connector-tools";
import { assertPublicConnectorTarget } from "@/lib/workspace-connectors";

describe("StreamableHttpMcpClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("initializes, retains the MCP session and calls discovered tools", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { protocolVersion: "2024-11-05" } }), { headers: { "mcp-session-id": "session_1", "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: "2", result: { tools: [{ name: "search", description: "搜索" }] } }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: "3", result: { content: [{ type: "text", text: "结果" }] } }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const client = new StreamableHttpMcpClient({ url: "https://mcp.example.com", headers: { authorization: "Bearer test" } });

    await client.initialize();
    await expect(client.listTools()).resolves.toEqual([{ name: "search", description: "搜索" }]);
    await expect(client.callTool("search", { query: "ZMZAI" })).resolves.toMatchObject({ output: "结果", metadata: { isError: false } });

    expect(assertPublicConnectorTarget).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2]![1]!.headers).toMatchObject({ "mcp-session-id": "session_1", authorization: "Bearer test" });
    expect(JSON.parse(fetch.mock.calls[3]![1]!.body as string)).toMatchObject({ method: "tools/call", params: { name: "search", arguments: { query: "ZMZAI" } } });
  });

  it("surfaces JSON-RPC errors without exposing credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "权限不足" } }), { headers: { "content-type": "application/json" } })));
    const client = new StreamableHttpMcpClient({ url: "https://mcp.example.com", headers: { authorization: "Bearer private" } });
    await expect(client.listTools()).rejects.toThrow("权限不足");
  });
});
