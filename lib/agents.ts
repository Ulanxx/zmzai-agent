import { randomUUID } from "node:crypto";

import { builtinAgents, type AgentInfo, type ResolvedAgent } from "@zmzai/agent-framework";
import { AgentModel, AgentVersionModel } from "@/models/agent";
import { WorkspaceModel } from "@/models/workspace";

export type AgentSummary = {
  id: string;
  name: string;
  description: string;
  icon: string;
  publishedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentVersionSnapshot = {
  id: string;
  agentId: string;
  workspaceId: string;
  version: number;
  agent: AgentInfo;
  capabilities: { tools: string[]; pluginIds: string[]; skillIds: string[]; connectorIds: string[] };
  createdAt: string;
};

function summary(record: { agentId: string; name: string; description: string; icon: string; publishedVersionId?: string | null; createdAt: Date; updatedAt: Date }): AgentSummary {
  return {
    id: record.agentId,
    name: record.name,
    description: record.description,
    icon: record.icon,
    publishedVersionId: record.publishedVersionId ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function snapshot(record: { agentVersionId: string; agentId: string; workspaceId: string; version: number; agent: unknown; capabilities?: { tools?: string[]; pluginIds?: string[]; skillIds?: string[]; connectorIds?: string[] } | null; createdAt: Date }): AgentVersionSnapshot {
  return {
    id: record.agentVersionId,
    agentId: record.agentId,
    workspaceId: record.workspaceId,
    version: record.version,
    agent: record.agent as AgentInfo,
    capabilities: {
      tools: record.capabilities?.tools ?? [],
      pluginIds: record.capabilities?.pluginIds ?? [],
      skillIds: record.capabilities?.skillIds ?? [],
      connectorIds: record.capabilities?.connectorIds ?? [],
    },
    createdAt: record.createdAt.toISOString(),
  };
}

export async function createAgent(input: {
  userId: string;
  workspaceId: string;
  name: string;
  description?: string;
  icon?: string;
  agent: AgentInfo;
  capabilities?: Partial<AgentVersionSnapshot["capabilities"]>;
  setWorkspaceDefault?: boolean;
}): Promise<{ agent: AgentSummary; version: AgentVersionSnapshot }> {
  const agentId = `agt_${randomUUID()}`;
  const agentVersionId = `agtver_${randomUUID()}`;
  const created = await AgentModel.create({
    agentId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    name: input.name,
    description: input.description ?? input.agent.description ?? "",
    icon: input.icon ?? "spark",
    publishedVersionId: agentVersionId,
  });
  const version = await AgentVersionModel.create({
    agentVersionId,
    agentId,
    workspaceId: input.workspaceId,
    version: 1,
    agent: input.agent,
    capabilities: {
      tools: input.capabilities?.tools ?? [],
      pluginIds: input.capabilities?.pluginIds ?? [],
      skillIds: input.capabilities?.skillIds ?? [],
      connectorIds: input.capabilities?.connectorIds ?? [],
    },
  });
  if (input.setWorkspaceDefault) await WorkspaceModel.updateOne({ workspaceId: input.workspaceId, userId: input.userId }, { $set: { defaultAgentId: agentId } });
  return { agent: summary(created), version: snapshot(version) };
}

/** Every cloud project has one immediately usable default Agent. This is
 *  idempotent so retries and existing workspaces are safe. */
export async function ensureDefaultAgent(input: { userId: string; workspaceId: string }): Promise<{ agent: AgentSummary; version: AgentVersionSnapshot } | null> {
  const workspace = await WorkspaceModel.findOne({ workspaceId: input.workspaceId, userId: input.userId }).select({ defaultAgentId: 1 }).lean();
  const existing = await AgentModel.findOne({
    workspaceId: input.workspaceId,
    userId: input.userId,
    ...(workspace?.defaultAgentId ? { agentId: workspace.defaultAgentId } : {}),
  }).sort({ createdAt: 1 });
  if (existing?.publishedVersionId) {
    if (workspace?.defaultAgentId !== existing.agentId) {
      await WorkspaceModel.updateOne({ workspaceId: input.workspaceId, userId: input.userId }, { $set: { defaultAgentId: existing.agentId } });
    }
    const version = await AgentVersionModel.findOne({ agentVersionId: existing.publishedVersionId }).lean();
    return version ? { agent: summary(existing), version: snapshot(version) } : null;
  }
  const defaultAgent = builtinAgents.find((candidate) => candidate.name === "default");
  if (!defaultAgent) throw new Error("默认 Agent 不可用");
  return createAgent({
    userId: input.userId,
    workspaceId: input.workspaceId,
    name: "默认 Agent",
    description: defaultAgent.description,
    agent: { ...defaultAgent, name: "default" },
    setWorkspaceDefault: true,
  });
}

export async function listAgents(userId: string, workspaceId: string): Promise<AgentSummary[]> {
  const records = await AgentModel.find({ userId, workspaceId }).sort({ updatedAt: -1 }).lean();
  return records.map(summary);
}

export async function getPublishedAgentVersion(input: { userId: string; workspaceId: string; agentId?: string }): Promise<AgentVersionSnapshot | null> {
  const workspace = input.agentId ? null : await WorkspaceModel.findOne({ userId: input.userId, workspaceId: input.workspaceId }).select({ defaultAgentId: 1 }).lean();
  const selector = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    ...(input.agentId ? { agentId: input.agentId } : workspace?.defaultAgentId ? { agentId: workspace.defaultAgentId } : {}),
  };
  const agent = await AgentModel.findOne(selector).sort({ createdAt: 1 }).lean();
  if (!agent?.publishedVersionId) return null;
  const version = await AgentVersionModel.findOne({ agentVersionId: agent.publishedVersionId, workspaceId: input.workspaceId }).lean();
  return version ? snapshot(version) : null;
}

export async function resolveAgentVersion(input: { userId: string; workspaceId: string; agentId?: string; agentVersionId: string }): Promise<ResolvedAgent | null> {
  const record = await AgentVersionModel.findOne({ agentVersionId: input.agentVersionId, workspaceId: input.workspaceId }).lean();
  if (!record || (input.agentId && record.agentId !== input.agentId)) return null;
  const owner = await AgentModel.exists({ agentId: record.agentId, workspaceId: input.workspaceId, userId: input.userId });
  if (!owner) return null;
  return { agent: record.agent as AgentInfo };
}
