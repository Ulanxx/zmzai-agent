import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { decryptConnectorHeaders, encryptConnectorHeaders } from "@/lib/connector-secrets";
import { WorkspaceConnectorModel } from "@/models/workspace-connector";

export type ConnectorTransport = "streamable-http" | "sse" | "github";
export type WorkspaceConnectorSummary = { id: string; name: string; transport: ConnectorTransport; url: string; status: "untested" | "ready" | "error"; lastCheckedAt: string | null; lastError: string | null };

const maxProbeResponseBytes = 1024 * 1024;

export function isMcpInitializeResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as { jsonrpc?: unknown; result?: unknown; error?: unknown };
  return response.jsonrpc === "2.0" && !response.error && Boolean(response.result && typeof response.result === "object" && !Array.isArray(response.result));
}

export function isGithubUserResponse(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "login" in value && typeof value.login === "string" && value.login.length > 0);
}

/** Streamable HTTP MCP permits either a JSON body or a single SSE message.
 * Keep probing aligned with the runtime client so a valid endpoint is never
 * marked broken solely because it chose the SSE response form. */
export function parseMcpInitializePayload(text: string, isSse: boolean): unknown {
  const candidates = isSse
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean)
    : [text];
  const payload = candidates.at(-1);
  if (!payload) throw new Error("MCP initialize 未返回 JSON-RPC 响应");
  try { return JSON.parse(payload) as unknown; } catch { throw new Error("MCP initialize 未返回 JSON-RPC 响应"); }
}

function summary(record: { connectorId: string; name: string; transport: ConnectorTransport; url: string; status: "untested" | "ready" | "error"; lastCheckedAt?: Date | null; lastError?: string | null }): WorkspaceConnectorSummary {
  return { id: record.connectorId, name: record.name, transport: record.transport, url: record.url, status: record.status, lastCheckedAt: record.lastCheckedAt?.toISOString() ?? null, lastError: record.lastError ?? null };
}

export function normalizeConnectorUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

export function isPublicConnectorAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    return true;
  }
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
  return isIP(address) === 6;
}

export async function assertPublicConnectorTarget(url: string): Promise<void> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("MCP 地址不能指向本地网络");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicConnectorAddress(address))) throw new Error("MCP 地址不能指向私有网络");
}

export async function listWorkspaceConnectors(input: { userId: string; workspaceId: string }): Promise<WorkspaceConnectorSummary[]> {
  const records = await WorkspaceConnectorModel.find({ userId: input.userId, workspaceId: input.workspaceId }).sort({ updatedAt: -1 }).lean();
  return records.map(summary);
}

export async function createWorkspaceConnector(input: { userId: string; workspaceId: string; name: string; transport: ConnectorTransport; url: string; headers: Record<string, string> }): Promise<WorkspaceConnectorSummary> {
  if (input.transport === "github") throw new Error("GitHub 连接器必须通过 OAuth 授权创建");
  if (input.transport !== "streamable-http" && input.transport !== "sse") throw new Error("不支持的 MCP 传输类型");
  const url = normalizeConnectorUrl(input.url);
  if (!url) throw new Error("MCP 地址必须是 HTTPS URL");
  await assertPublicConnectorTarget(url);
  const record = await WorkspaceConnectorModel.create({ connectorId: `mcp_${randomUUID()}`, userId: input.userId, workspaceId: input.workspaceId, name: input.name, transport: input.transport, url, encryptedHeaders: encryptConnectorHeaders(input.headers) });
  await import("@/models/workspace").then(({ WorkspaceModel }) => WorkspaceModel.updateOne({ userId: input.userId, workspaceId: input.workspaceId }, { $addToSet: { connectorIds: record.connectorId } }));
  return summary(record);
}

/** GitHub OAuth access tokens are stored in the same encrypted credential
 * field as MCP headers, never in a product-facing API response. */
export async function createGithubWorkspaceConnector(input: { userId: string; workspaceId: string; accessToken: string }): Promise<WorkspaceConnectorSummary> {
  const encryptedHeaders = encryptConnectorHeaders({ authorization: `Bearer ${input.accessToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });
  const existing = await WorkspaceConnectorModel.findOne({ userId: input.userId, workspaceId: input.workspaceId, transport: "github" });
  if (existing) {
    existing.encryptedHeaders = encryptedHeaders;
    existing.status = "untested";
    existing.lastError = null;
    existing.lastCheckedAt = null;
    await existing.save();
    return summary(existing);
  }
  const record = await WorkspaceConnectorModel.create({ connectorId: `gh_${randomUUID()}`, userId: input.userId, workspaceId: input.workspaceId, name: "GitHub", transport: "github", url: "https://api.github.com/", encryptedHeaders });
  await import("@/models/workspace").then(({ WorkspaceModel }) => WorkspaceModel.updateOne({ userId: input.userId, workspaceId: input.workspaceId }, { $addToSet: { connectorIds: record.connectorId } }));
  return summary(record);
}

export async function deleteWorkspaceConnector(input: { userId: string; workspaceId: string; connectorId: string }): Promise<boolean> {
  const deleted = await WorkspaceConnectorModel.deleteOne({ userId: input.userId, workspaceId: input.workspaceId, connectorId: input.connectorId });
  if (!deleted.deletedCount) return false;
  await import("@/models/workspace").then(({ WorkspaceModel }) => WorkspaceModel.updateOne({ userId: input.userId, workspaceId: input.workspaceId }, { $pull: { connectorIds: input.connectorId } }));
  return true;
}

export async function workspaceOwnsConnectorIds(input: { userId: string; workspaceId: string; connectorIds: string[] }): Promise<boolean> {
  const ids = [...new Set(input.connectorIds)];
  if (ids.length !== input.connectorIds.length) return false;
  if (!ids.length) return true;
  return (await WorkspaceConnectorModel.countDocuments({ userId: input.userId, workspaceId: input.workspaceId, connectorId: { $in: ids } })).valueOf() === ids.length;
}

/** This is a protocol probe, not an MCP tool invocation. `initialize` is the
 * MCP handshake and has no business side effect, unlike `tools/call`. */
export async function testWorkspaceConnector(input: { userId: string; workspaceId: string; connectorId: string }): Promise<WorkspaceConnectorSummary | null> {
  const connector = await WorkspaceConnectorModel.findOne({ userId: input.userId, workspaceId: input.workspaceId, connectorId: input.connectorId }).select("+encryptedHeaders");
  if (!connector) return null;
  let status: "ready" | "error" = "ready";
  let lastError: string | null = null;
  try {
    await assertPublicConnectorTarget(connector.url);
    const headers = decryptConnectorHeaders(connector.encryptedHeaders);
    if (connector.transport === "github") {
      const response = await fetch(new URL("user", connector.url).toString(), {
        headers: { accept: "application/vnd.github+json", ...headers },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`GitHub /user 返回 ${response.status}`);
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > maxProbeResponseBytes) throw new Error("GitHub /user 响应超过 1 MiB 限制");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxProbeResponseBytes) throw new Error("GitHub /user 响应超过 1 MiB 限制");
      let payload: unknown;
      try { payload = JSON.parse(text) as unknown; } catch { throw new Error("GitHub /user 返回了无效 JSON"); }
      if (!isGithubUserResponse(payload)) throw new Error("GitHub /user 响应格式无效");
    } else if (connector.transport === "sse") {
      const { SseMcpClient } = await import("@/lib/mcp-connector-tools");
      const client = new SseMcpClient({ url: connector.url, headers });
      try {
        await client.initialize();
      } finally {
        client.close();
      }
    } else {
      const response = await fetch(connector.url, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "zmzai-agent", version: "0.1" } } }),
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`MCP initialize 返回 ${response.status}`);
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > maxProbeResponseBytes) throw new Error("MCP initialize 响应超过 1 MiB 限制");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxProbeResponseBytes) throw new Error("MCP initialize 响应超过 1 MiB 限制");
      const payload = parseMcpInitializePayload(text, response.headers.get("content-type")?.includes("text/event-stream") ?? false);
      if (!isMcpInitializeResponse(payload)) throw new Error("MCP initialize 响应格式无效");
    }
  } catch (error) {
    status = "error";
    lastError = error instanceof Error ? error.message.slice(0, 1_000) : "连接失败";
  }
  connector.status = status;
  connector.lastError = lastError;
  connector.lastCheckedAt = new Date();
  await connector.save();
  return summary(connector);
}
