import { randomUUID } from "node:crypto";

import { importGithubAgentPlugin } from "@/lib/github-agent-plugins";
import { WorkspacePluginModel } from "@/models/workspace-plugin";

export type WorkspacePluginSummary = {
  id: string;
  name: string;
  version: string;
  description: string;
  repository: string;
  requestedRef: string;
  commitSha: string;
  path: string;
  skillCount: number;
  mcpServerCount: number;
  errors: string[];
  createdAt: string;
};

function summary(record: { pluginId: string; name: string; version?: string; description: string; repository: string; requestedRef: string; commitSha: string; path: string; skills?: unknown[]; mcpServers?: unknown; errors?: string[]; createdAt: Date }): WorkspacePluginSummary {
  return {
    id: record.pluginId, name: record.name, version: record.version ?? "", description: record.description,
    repository: record.repository, requestedRef: record.requestedRef, commitSha: record.commitSha, path: record.path,
    skillCount: record.skills?.length ?? 0, mcpServerCount: record.mcpServers && typeof record.mcpServers === "object" ? Object.keys(record.mcpServers).length : 0,
    errors: record.errors ?? [], createdAt: record.createdAt.toISOString(),
  };
}

export async function listWorkspacePlugins(input: { userId: string; workspaceId: string }): Promise<WorkspacePluginSummary[]> {
  const records = await WorkspacePluginModel.find({ userId: input.userId, workspaceId: input.workspaceId }).sort({ createdAt: -1 }).lean();
  return records.map(summary);
}

export async function addGithubWorkspacePlugin(input: { userId: string; workspaceId: string; repository: string; ref?: string; path?: string }): Promise<{ plugin: WorkspacePluginSummary; reused: boolean }> {
  const imported = await importGithubAgentPlugin(input);
  const existing = await WorkspacePluginModel.findOne({ workspaceId: input.workspaceId, repository: imported.repository, commitSha: imported.commitSha, path: imported.path }).lean();
  if (existing) return { plugin: summary(existing), reused: true };
  const plugin = await WorkspacePluginModel.create({
    pluginId: `plg_${randomUUID()}`, userId: input.userId, workspaceId: input.workspaceId,
    repository: imported.repository, requestedRef: imported.requestedRef, commitSha: imported.commitSha, path: imported.path,
    name: imported.plugin.manifest.name, version: imported.plugin.manifest.version ?? "", description: imported.plugin.manifest.description ?? "",
    skills: imported.plugin.skills, mcpServers: imported.plugin.mcpServers, errors: imported.plugin.errors,
  });
  return { plugin: summary(plugin), reused: false };
}

export async function workspaceOwnsPluginIds(input: { userId: string; workspaceId: string; pluginIds: string[] }): Promise<boolean> {
  const ids = [...new Set(input.pluginIds)];
  if (ids.length !== input.pluginIds.length) return false;
  if (!ids.length) return true;
  return (await WorkspacePluginModel.countDocuments({ userId: input.userId, workspaceId: input.workspaceId, pluginId: { $in: ids } })).valueOf() === ids.length;
}

export async function getWorkspacePluginSkillsByIds(input: { userId: string; workspaceId: string; pluginIds: string[] }): Promise<Array<{ name: string; markdown: string }>> {
  const ids = [...new Set(input.pluginIds)];
  if (!ids.length) return [];
  const records = await WorkspacePluginModel.find({ userId: input.userId, workspaceId: input.workspaceId, pluginId: { $in: ids } }).lean();
  const byId = new Map(records.map((record) => [record.pluginId, record]));
  return ids.flatMap((id) => (byId.get(id)?.skills ?? []).flatMap((skill) => typeof skill?.markdown === "string" ? [{ name: skill.id || "Plugin Skill", markdown: skill.markdown }] : []));
}
