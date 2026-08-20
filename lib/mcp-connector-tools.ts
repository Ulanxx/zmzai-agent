import { createHash, randomUUID } from "node:crypto";

import type { ToolDef } from "@zmzai/agent-framework";
import { z } from "zod";

import { decryptConnectorHeaders } from "@/lib/connector-secrets";
import { assertPublicConnectorTarget } from "@/lib/workspace-connectors";
import { WorkspaceConnectorModel } from "@/models/workspace-connector";

const maxResponseBytes = 1024 * 1024;
const protocolVersion = "2024-11-05";

type McpToolDescriptor = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type JsonRpcSuccess = { jsonrpc?: string; id?: string | number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

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
    if (payload.error) throw new Error(payload.error.message || `MCP ${method} 失败`);
    return payload.result ?? null;
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

function connectorTool(input: { connectorId: string; connectorName: string; tool: McpToolDescriptor; client: StreamableHttpMcpClient }): ToolDef {
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
    transport: "streamable-http",
  }).select("+encryptedHeaders").lean();
  const tools: ToolDef[] = [];
  for (const connector of connectors) {
    try {
      const client = new StreamableHttpMcpClient({ url: connector.url, headers: decryptConnectorHeaders(connector.encryptedHeaders) });
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
