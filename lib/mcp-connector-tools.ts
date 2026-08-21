import { createHash, randomUUID } from "node:crypto";

import type { ToolDef } from "@zmzai/agent-framework";
import { z } from "zod";

import { decryptConnectorHeaders } from "@/lib/connector-secrets";
import { githubConnectorTools } from "@/lib/github-connector-tools";
import { assertPublicConnectorTarget } from "@/lib/workspace-connectors";
import { WorkspaceConnectorModel } from "@/models/workspace-connector";

const maxResponseBytes = 1024 * 1024;
const protocolVersion = "2024-11-05";

type McpToolDescriptor = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type JsonRpcSuccess = { jsonrpc?: string; id?: string | number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
type McpClient = {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ output: string; metadata: Record<string, unknown> }>;
};

function toolId(connectorId: string, toolName: string): string {
  const connectorHash = createHash("sha256").update(connectorId).digest("hex").slice(0, 8);
  const toolSlug = toolName.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42) || "tool";
  return `mcp_${connectorHash}_${toolSlug}`;
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  try { return JSON.stringify(value); } catch { return "连接器返回了无法序列化的结果"; }
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxResponseBytes) throw new Error("MCP 响应超过 1 MiB 限制");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel();
      throw new Error("MCP 响应超过 1 MiB 限制");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseRpcPayload(text: string, isSse: boolean): JsonRpcSuccess {
  const candidates = isSse
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean)
    : [text];
  const payload = candidates.at(-1);
  if (!payload) throw new Error("MCP 服务没有返回 JSON-RPC 响应");
  try { return JSON.parse(payload) as JsonRpcSuccess; } catch { throw new Error("MCP 服务返回了无效的 JSON-RPC 响应"); }
}

function rpcError(payload: JsonRpcSuccess, method: string): unknown {
  if (payload.error) throw new Error(payload.error.message || `MCP ${method} 失败`);
  return payload.result ?? null;
}

export class StreamableHttpMcpClient {
  private sessionId: string | null = null;

  constructor(private readonly input: { url: string; headers: Record<string, string> }) {}

  private async rpc(method: string, params?: unknown, notification = false): Promise<unknown> {
    await assertPublicConnectorTarget(this.input.url);
    const requestId = notification ? undefined : randomUUID();
    const response = await fetch(this.input.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...this.input.headers,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(requestId ? { id: requestId } : {}), method, ...(params === undefined ? {} : { params }) }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && response.status !== 202 && response.status !== 204) throw new Error(`MCP ${method} 返回 ${response.status}`);
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (notification || response.status === 202 || response.status === 204) return null;
    const payload = parseRpcPayload(await boundedText(response), response.headers.get("content-type")?.includes("text/event-stream") ?? false);
    return rpcError(payload, method);
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "zmzai-agent", version: "0.1" } });
    await this.rpc("notifications/initialized", undefined, true);
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.rpc("tools/list") as { tools?: unknown } | null;
    if (!result || !Array.isArray(result.tools)) throw new Error("MCP 服务未返回 tools/list 结果");
    return result.tools
      .filter((tool): tool is McpToolDescriptor => Boolean(tool) && typeof tool === "object" && "name" in tool && typeof tool.name === "string" && tool.name.length > 0)
      .slice(0, 32);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ output: string; metadata: Record<string, unknown> }> {
    const result = await this.rpc("tools/call", { name, arguments: args }) as { content?: unknown; isError?: unknown; structuredContent?: unknown } | null;
    const content = Array.isArray(result?.content) ? result.content : [];
    const output = content.length ? content.map(safeText).join("\n\n") : safeText(result?.structuredContent ?? result ?? "MCP 工具未返回内容");
    return { output, metadata: { isError: Boolean(result?.isError), ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) } };
  }
}

/** Legacy MCP-over-SSE transport. The SSE endpoint supplies a short-lived
 * messages URL; both endpoints are independently validated to keep an
 * untrusted MCP server from turning the connector into an SSRF pivot. */
export class SseMcpClient implements McpClient {
  private messageUrl: string | null = null;
  private connecting: Promise<void> | null = null;
  private streamAbort: AbortController | null = null;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly input: { url: string; headers: Record<string, string> }) {}

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.connecting = null;
    this.messageUrl = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("MCP SSE 会话已关闭"));
    }
    this.pending.clear();
  }

  private scheduleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), 120_000);
    this.idleTimer.unref?.();
  }

  private async ensureConnected(): Promise<void> {
    if (this.messageUrl) return;
    if (!this.connecting) this.connecting = this.openConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async openConnection(): Promise<void> {
    await assertPublicConnectorTarget(this.input.url);
    const controller = new AbortController();
    this.streamAbort = controller;
    let resolveEndpoint!: () => void;
    let rejectEndpoint!: (reason: Error) => void;
    const endpointReady = new Promise<void>((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
    try {
      const response = await fetch(this.input.url, {
        headers: { accept: "text/event-stream", ...this.input.headers },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`MCP SSE 连接返回 ${response.status}`);
      if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("MCP SSE 连接未返回 text/event-stream");
      if (!response.body) throw new Error("MCP SSE 连接没有响应体");
      void this.consumeStream(response.body, async (event, data) => {
        if (event === "endpoint") {
          const endpoint = new URL(data, this.input.url);
          if (endpoint.protocol !== "https:") throw new Error("MCP SSE messages 地址必须是 HTTPS URL");
          await assertPublicConnectorTarget(endpoint.toString());
          this.messageUrl = endpoint.toString();
          resolveEndpoint();
          return;
        }
        if (event !== "message") return;
        const payload = JSON.parse(data) as JsonRpcSuccess;
        if (payload.id === undefined) return;
        const request = this.pending.get(String(payload.id));
        if (!request) return;
        clearTimeout(request.timeout);
        this.pending.delete(String(payload.id));
        if (payload.error) request.reject(new Error(payload.error.message || "MCP SSE 请求失败"));
        else request.resolve(payload.result ?? null);
      }, (error) => rejectEndpoint(error));
      await endpointReady;
    } catch (error) {
      const reason = error instanceof Error ? error : new Error("MCP SSE 连接失败");
      rejectEndpoint(reason);
      this.close();
      throw reason;
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => Promise<void>, onFailure: (error: Error) => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consumeRecord = async (record: string) => {
      const lines = record.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) await onEvent(event, data);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > maxResponseBytes) throw new Error("MCP SSE 事件超过 1 MiB 限制");
        const records = buffer.split(/\r?\n\r?\n/);
        buffer = records.pop() ?? "";
        for (const record of records) await consumeRecord(record);
      }
      if (buffer.trim()) await consumeRecord(buffer);
      throw new Error("MCP SSE 连接已关闭");
    } catch (error) {
      const reason = error instanceof Error ? error : new Error("MCP SSE 连接失败");
      if (this.streamAbort?.signal.aborted) return;
      this.messageUrl = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(reason);
      }
      this.pending.clear();
      onFailure(reason);
    }
  }

  private async rpc(method: string, params?: unknown, notification = false): Promise<unknown> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.ensureConnected();
    const endpoint = this.messageUrl;
    if (!endpoint) throw new Error("MCP SSE 未提供 messages 地址");
    await assertPublicConnectorTarget(endpoint);
    const id = notification ? undefined : randomUUID();
    const result = id
      ? new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`MCP ${method} 响应超时`));
        }, 30_000);
        this.pending.set(id, { resolve, reject, timeout });
      })
      : null;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...this.input.headers },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, ...(params === undefined ? {} : { params }) }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok && response.status !== 202 && response.status !== 204) throw new Error(`MCP ${method} 返回 ${response.status}`);
      if (!result) return null;
      return await result;
    } catch (error) {
      if (id) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
        }
      }
      throw error;
    } finally {
      this.scheduleClose();
    }
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "zmzai-agent", version: "0.1" } });
    await this.rpc("notifications/initialized", undefined, true);
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.rpc("tools/list") as { tools?: unknown } | null;
    if (!result || !Array.isArray(result.tools)) throw new Error("MCP 服务未返回 tools/list 结果");
    return result.tools
      .filter((tool): tool is McpToolDescriptor => Boolean(tool) && typeof tool === "object" && "name" in tool && typeof tool.name === "string" && tool.name.length > 0)
      .slice(0, 32);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ output: string; metadata: Record<string, unknown> }> {
    const result = await this.rpc("tools/call", { name, arguments: args }) as { content?: unknown; isError?: unknown; structuredContent?: unknown } | null;
    const content = Array.isArray(result?.content) ? result.content : [];
    const output = content.length ? content.map(safeText).join("\n\n") : safeText(result?.structuredContent ?? result ?? "MCP 工具未返回内容");
    return { output, metadata: { isError: Boolean(result?.isError), ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) } };
  }
}

function connectorTool(input: { connectorId: string; connectorName: string; tool: McpToolDescriptor; client: McpClient }): ToolDef {
  const id = toolId(input.connectorId, input.tool.name);
  const schemaDescription = input.tool.inputSchema ? `\n输入 schema：${JSON.stringify(input.tool.inputSchema).slice(0, 6_000)}` : "";
  return {
    id,
    label: `${input.connectorName} · ${input.tool.name}`,
    description: `${input.tool.description || `调用 ${input.connectorName} 的 ${input.tool.name}`}。把 MCP 输入放在 arguments 对象中。${schemaDescription}`,
    parameters: z.object({ arguments: z.record(z.string().min(1).max(128), z.unknown()).default({}) }),
    permission: () => ({
      permission: "connector",
      patterns: [`${input.connectorName}/${input.tool.name}`],
      always: [`${input.connectorName}/${input.tool.name}`],
      metadata: { connectorId: input.connectorId, connectorName: input.connectorName, toolName: input.tool.name, action: "MCP tools/call" },
    }),
    executionMode: "sequential",
    async execute(args) {
      const result = await input.client.callTool(input.tool.name, args.arguments);
      return { title: `${input.connectorName} · ${input.tool.name}`, output: result.output, metadata: { connectorId: input.connectorId, connectorName: input.connectorName, toolName: input.tool.name, ...result.metadata } };
    },
  };
}

/** Resolves only the connectors explicitly bound to a Workspace. Discovery is
 * read-only; every actual tools/call is routed through the normal permission
 * choke point, so a connected service never becomes silent authority. */
export async function resolveWorkspaceConnectorTools(input: { userId: string; workspaceId: string; connectorIds: string[] }): Promise<ToolDef[]> {
  if (!input.connectorIds.length) return [];
  const connectors = await WorkspaceConnectorModel.find({
    userId: input.userId,
    workspaceId: input.workspaceId,
    connectorId: { $in: [...new Set(input.connectorIds)] },
    status: "ready",
    transport: { $in: ["streamable-http", "sse", "github"] },
  }).select("+encryptedHeaders").lean();
  const tools: ToolDef[] = [];
  for (const connector of connectors) {
    try {
      const headers = decryptConnectorHeaders(connector.encryptedHeaders);
      if (connector.transport === "github") {
        tools.push(...githubConnectorTools({ connectorId: connector.connectorId, connectorName: connector.name, headers }));
        continue;
      }
      const client = connector.transport === "sse"
        ? new SseMcpClient({ url: connector.url, headers })
        : new StreamableHttpMcpClient({ url: connector.url, headers });
      await client.initialize();
      const remoteTools = await client.listTools();
      tools.push(...remoteTools.map((tool) => connectorTool({ connectorId: connector.connectorId, connectorName: connector.name, tool, client })));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : "MCP 工具发现失败";
      await WorkspaceConnectorModel.updateOne({ connectorId: connector.connectorId, userId: input.userId }, { $set: { status: "error", lastError: message, lastCheckedAt: new Date() } });
    }
  }
  return tools;
}
