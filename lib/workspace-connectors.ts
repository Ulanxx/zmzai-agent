import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { decryptConnectorHeaders, encryptConnectorHeaders } from "@/lib/connector-secrets";
import { WorkspaceConnectorModel } from "@/models/workspace-connector";

export type ConnectorTransport = "streamable-http" | "sse";
export type WorkspaceConnectorSummary = { id: string; name: string; transport: ConnectorTransport; url: string; status: "untested" | "ready" | "error"; lastCheckedAt: string | null; lastError: string | null };

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

async function assertPublicConnectorTarget(url: string): Promise<void> {
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
  const url = normalizeConnectorUrl(input.url);
  if (!url) throw new Error("MCP 地址必须是 HTTPS URL");
  await assertPublicConnectorTarget(url);
  const record = await WorkspaceConnectorModel.create({ connectorId: `mcp_${randomUUID()}`, userId: input.userId, workspaceId: input.workspaceId, name: input.name, transport: input.transport, url, encryptedHeaders: encryptConnectorHeaders(input.headers) });
  return summary(record);
}

export async function workspaceOwnsConnectorIds(input: { userId: string; workspaceId: string; connectorIds: string[] }): Promise<boolean> {
  const ids = [...new Set(input.connectorIds)];
  if (ids.length !== input.connectorIds.length) return false;
  if (!ids.length) return true;
  return (await WorkspaceConnectorModel.countDocuments({ userId: input.userId, workspaceId: input.workspaceId, connectorId: { $in: ids } })).valueOf() === ids.length;
}

/** This is a connectivity probe, not an MCP tool invocation. It uses GET to
 * avoid issuing an initialize call against a remote service. */
export async function testWorkspaceConnector(input: { userId: string; workspaceId: string; connectorId: string }): Promise<WorkspaceConnectorSummary | null> {
  const connector = await WorkspaceConnectorModel.findOne({ userId: input.userId, workspaceId: input.workspaceId, connectorId: input.connectorId }).select("+encryptedHeaders");
  if (!connector) return null;
  let status: "ready" | "error" = "ready";
  let lastError: string | null = null;
  try {
    await assertPublicConnectorTarget(connector.url);
    const response = await fetch(connector.url, { method: "GET", headers: { accept: "application/json, text/event-stream", ...decryptConnectorHeaders(connector.encryptedHeaders) }, signal: AbortSignal.timeout(10_000), cache: "no-store", redirect: "error" });
    if (response.status >= 500) throw new Error(`远端返回 ${response.status}`);
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
