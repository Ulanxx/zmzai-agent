import { canonicalWorkspacePath } from "@/lib/workspace-path";
import { WorkspaceFileModel } from "@/models/workspace-file";
import { WorkspaceRevisionModel } from "@/models/workspace-revision";
import { WorkspaceModel } from "@/models/workspace";

export type WorkspaceSummary = {
  id: string;
  name: string;
  description: string;
  currentRevisionId?: string | null;
  defaultModel: string;
  approvalMode: "always";
  defaultAgentId?: string | null;
  createdAt: string;
  updatedAt: string;
};

function toWorkspaceSummary(workspace: {
  workspaceId: string;
  name: string;
  description: string;
  currentRevisionId?: string | null;
  defaultModel: string;
  approvalMode: "always";
  defaultAgentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceSummary {
  return {
    id: workspace.workspaceId,
    name: workspace.name,
    description: workspace.description,
    currentRevisionId: workspace.currentRevisionId ?? null,
    defaultModel: workspace.defaultModel,
    approvalMode: workspace.approvalMode,
    defaultAgentId: workspace.defaultAgentId ?? null,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  };
}

export async function createWorkspace(input: { workspaceId: string; userId: string; name: string; description: string; defaultModel: string }): Promise<WorkspaceSummary> {
  const workspace = await WorkspaceModel.create({
    workspaceId: input.workspaceId,
    userId: input.userId,
    name: input.name,
    description: input.description,
    defaultModel: input.defaultModel,
    approvalMode: "always",
  });
  return toWorkspaceSummary(workspace);
}

export async function getWorkspace(userId: string, workspaceId: string): Promise<WorkspaceSummary | null> {
  const workspace = await WorkspaceModel.findOne({ userId, workspaceId }).lean();
  return workspace ? toWorkspaceSummary(workspace) : null;
}

export async function listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  const workspaces = await WorkspaceModel.find({ userId }).sort({ updatedAt: -1 }).lean();
  return workspaces.map(toWorkspaceSummary);
}

export async function listWorkspaceFiles(userId: string, workspaceId: string) {
  if (!(await WorkspaceModel.exists({ userId, workspaceId }))) return null;
  const files = await WorkspaceFileModel.find({ workspaceId }).sort({ path: 1 }).lean();
  return files.map((file) => ({ path: file.path, content: file.content, revisionId: file.revisionId, updatedAt: file.updatedAt.toISOString() }));
}

export async function listWorkspaceRevisions(userId: string, workspaceId: string) {
  if (!(await WorkspaceModel.exists({ userId, workspaceId }))) return null;
  const revisions = await WorkspaceRevisionModel.find({ workspaceId }).sort({ createdAt: -1 }).lean();
  return revisions.map((revision) => ({
    id: revision.revisionId,
    parentRevisionId: revision.parentRevisionId,
    author: revision.author,
    changes: revision.changes,
    summary: revision.summary,
    createdAt: revision.createdAt.toISOString(),
  }));
}

export function validatedWorkspacePath(path: string): string | null {
  return canonicalWorkspacePath(path);
}
