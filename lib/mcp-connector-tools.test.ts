import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace-connectors", () => ({ assertPublicConnectorTarget: vi.fn().mockResolvedValue(undefined) }));

import { SseMcpClient, StreamableHttpMcpClient } from "@/lib/mcp-connector-tools";
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

describe("SseMcpClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the legacy SSE session, receives RPC results, and posts to its verified messages endpoint", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        next.enqueue(encoder.encode("event: endpoint\ndata: /messages?sessionId=legacy_1\n\n"));
      },
    });
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      const request = JSON.parse(String(init.body)) as { id?: string; method: string };
      if (request.id) {
        const result = request.method === "initialize"
          ? { protocolVersion: "2024-11-05" }
          : request.method === "tools/list"
            ? { tools: [{ name: "search", description: "搜索" }] }
            : { content: [{ type: "text", text: "SSE 结果" }] };
        queueMicrotask(() => controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n\n`)));
      }
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetch);
    const client = new SseMcpClient({ url: "https://mcp.example.com/sse", headers: { authorization: "Bearer test" } });

    await client.initialize();
    await expect(client.listTools()).resolves.toEqual([{ name: "search", description: "搜索" }]);
    await expect(client.callTool("search", { query: "ZMZAI" })).resolves.toMatchObject({ output: "SSE 结果", metadata: { isError: false } });
    client.close();

    expect(fetch.mock.calls[0]![0]).toBe("https://mcp.example.com/sse");
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ accept: "text/event-stream", authorization: "Bearer test" });
    expect(fetch.mock.calls.slice(1).every(([url]) => url === "https://mcp.example.com/messages?sessionId=legacy_1")).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ method: "tools/call", params: { name: "search", arguments: { query: "ZMZAI" } } });
    expect(assertPublicConnectorTarget).toHaveBeenCalledWith("https://mcp.example.com/messages?sessionId=legacy_1");
  });
});
