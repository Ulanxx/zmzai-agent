import { randomUUID } from "node:crypto";

import { importGithubSkill } from "@/lib/github-skills";
import { WorkspaceSkillModel } from "@/models/workspace-skill";

export type WorkspaceSkillSummary = {
  id: string;
  name: string;
  description: string;
  repository: string;
  requestedRef: string;
  commitSha: string;
  path: string;
  createdAt: string;
};

function summary(record: { skillId: string; name: string; description: string; repository: string; requestedRef: string; commitSha: string; path: string; createdAt: Date }): WorkspaceSkillSummary {
  return { id: record.skillId, name: record.name, description: record.description, repository: record.repository, requestedRef: record.requestedRef, commitSha: record.commitSha, path: record.path, createdAt: record.createdAt.toISOString() };
}

export async function listWorkspaceSkills(input: { userId: string; workspaceId: string }): Promise<WorkspaceSkillSummary[]> {
  const records = await WorkspaceSkillModel.find({ userId: input.userId, workspaceId: input.workspaceId }).sort({ createdAt: -1 }).lean();
  return records.map(summary);
}

/** Resolve only workspace-owned immutable copies. Agent versions retain the
 * IDs; this lookup supplies their pinned markdown at execution time. */
export async function getWorkspaceSkillsByIds(input: { userId: string; workspaceId: string; skillIds: string[] }): Promise<Array<{ skillId: string; name: string; markdown: string }>> {
  const ids = [...new Set(input.skillIds)];
  if (!ids.length) return [];
  const records = await WorkspaceSkillModel.find({
    userId: input.userId,
    workspaceId: input.workspaceId,
    skillId: { $in: ids },
  }).lean();
  const byId = new Map(records.map((record) => [record.skillId, record]));
  return ids.flatMap((id) => {
    const record = byId.get(id);
    return record ? [{ skillId: record.skillId, name: record.name, markdown: record.markdown }] : [];
  });
}

export async function workspaceOwnsSkillIds(input: { userId: string; workspaceId: string; skillIds: string[] }): Promise<boolean> {
  const ids = [...new Set(input.skillIds)];
  if (ids.length !== input.skillIds.length) return false;
  return (await getWorkspaceSkillsByIds(input)).length === ids.length;
}

export async function addGithubWorkspaceSkill(input: { userId: string; workspaceId: string; repository: string; ref?: string; path: string }): Promise<{ skill: WorkspaceSkillSummary; reused: boolean }> {
  const imported = await importGithubSkill(input);
  const existing = await WorkspaceSkillModel.findOne({ workspaceId: input.workspaceId, repository: imported.repository, commitSha: imported.commitSha, path: imported.path }).lean();
  if (existing) return { skill: summary(existing), reused: true };
  const skill = await WorkspaceSkillModel.create({ skillId: `skl_${randomUUID()}`, userId: input.userId, workspaceId: input.workspaceId, ...imported });
  return { skill: summary(skill), reused: false };
}
