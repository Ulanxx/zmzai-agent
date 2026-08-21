import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import { connectMongo } from "@/lib/database/mongodb";
import { AgentApiKeyModel } from "@/models/agent-api-key";

export const agentApiScopes = ["tasks:write", "tasks:read", "artifacts:read", "webhooks:write"] as const;
export type AgentApiScope = (typeof agentApiScopes)[number];

export type ResolvedAgentApiKey = {
  id: string;
  userId: string;
  workspaceIds: string[];
  scopes: AgentApiScope[];
};

export function hashAgentApiKey(value: string): string {
  return createHash("sha256").update(`zma:${value}`, "utf8").digest("hex");
}

export function generateAgentApiKey(): { plaintext: string; keyHash: string; prefix: string } {
  const plaintext = `zma_${randomBytes(32).toString("base64url")}`;
  return { plaintext, keyHash: hashAgentApiKey(plaintext), prefix: plaintext.slice(0, 16) };
}

export function parseBearerApiKey(value: string | null): string | null {
  const match = value?.match(/^Bearer\s+(zma_[A-Za-z0-9_-]{32,})$/i);
  return match?.[1] ?? null;
}

export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createAgentApiKey(input: { userId: string; name: string; workspaceIds: string[]; scopes: AgentApiScope[] }) {
  const generated = generateAgentApiKey();
  await connectMongo();
  const record = await AgentApiKeyModel.create({
    agentApiKeyId: `ak_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    userId: input.userId,
    name: input.name,
    keyHash: generated.keyHash,
    prefix: generated.prefix,
    workspaceIds: input.workspaceIds,
    scopes: input.scopes,
    status: "active",
  });
  return { key: generated.plaintext, record };
}

export async function resolveAgentApiKey(value: string): Promise<ResolvedAgentApiKey | null> {
  if (!value.startsWith("zma_")) return null;
  await connectMongo();
  const record = await AgentApiKeyModel.findOne({ keyHash: hashAgentApiKey(value), status: "active" }).select("+keyHash").lean();
  if (!record) return null;
  void AgentApiKeyModel.updateOne({ agentApiKeyId: record.agentApiKeyId, status: "active" }, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);
  return {
    id: record.agentApiKeyId,
    userId: record.userId,
    workspaceIds: record.workspaceIds,
    scopes: record.scopes.filter((scope): scope is AgentApiScope => (agentApiScopes as readonly string[]).includes(scope)),
  };
}
