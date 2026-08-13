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
  // 按创建时间降序（新的在前），不随会话/Agent 活动跳动——updatedAt 会被
  // 运行中的 Agent 频繁刷新，按它排序会让列表顺序在浏览时乱跳。
  const workspaces = await WorkspaceModel.find({ userId }).sort({ createdAt: -1 }).lean();
  return workspaces.map(toWorkspaceSummary);
}

/** 重命名/更新 Workspace 基本信息。 */
export async function updateWorkspace(userId: string, workspaceId: string, patch: { name?: string; description?: string }): Promise<WorkspaceSummary | null> {
  const set: Record<string, string> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (!Object.keys(set).length) return getWorkspace(userId, workspaceId);
  const updated = await WorkspaceModel.findOneAndUpdate({ userId, workspaceId }, { $set: set }, { new: true }).lean();
  return updated ? toWorkspaceSummary(updated) : null;
}

/**
 * 删除 Workspace 及其全部关联数据（F2，危险操作）：
 * 框架会话（含消息/部件/事件/序号）、沙箱产物（含 GridFS）、
 * 文件与版本、skills/plugins/connectors、Agent 定义与版本，最后删 Workspace 本身。
 * 幂等：目标不存在时返回 false。
 */
export async function deleteWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const workspace = await WorkspaceModel.findOne({ userId, workspaceId }).lean();
  if (!workspace) return false;

  const { FrameworkSessionModel, FrameworkMessageModel, FrameworkPartModel } = await import("@/framework/core/session/mongo-models");
  const { FrameworkEventModel, FrameworkSeqModel } = await import("@/framework/core/events/mongo-models");
  const { deleteRunArtifacts } = await import("@/lib/artifact-storage");
  const { AgentModel, AgentVersionModel } = await import("@/models/agent");
  const { WorkspaceSkillModel } = await import("@/models/workspace-skill");
  const { WorkspacePluginModel } = await import("@/models/workspace-plugin");
  const { WorkspaceConnectorModel } = await import("@/models/workspace-connector");

  const sessions = await FrameworkSessionModel.find({ workspaceId }).select({ sessionId: 1 }).lean();
  const sessionIds = sessions.map((session) => session.sessionId);
  await Promise.all(sessionIds.map((sessionId) => deleteRunArtifacts(sessionId).catch(() => undefined)));
  if (sessionIds.length) {
    await Promise.all([
      FrameworkMessageModel.deleteMany({ sessionId: { $in: sessionIds } }),
      FrameworkPartModel.deleteMany({ sessionId: { $in: sessionIds } }),
      FrameworkEventModel.deleteMany({ sessionId: { $in: sessionIds } }),
      FrameworkSeqModel.deleteMany({ sessionId: { $in: sessionIds } }),
    ]);
  }
  await FrameworkSessionModel.deleteMany({ workspaceId });

  await Promise.all([
    WorkspaceFileModel.deleteMany({ workspaceId }),
    WorkspaceRevisionModel.deleteMany({ workspaceId }),
    WorkspaceSkillModel.deleteMany({ workspaceId }),
    WorkspacePluginModel.deleteMany({ workspaceId }),
    WorkspaceConnectorModel.deleteMany({ workspaceId }),
    AgentModel.deleteMany({ workspaceId }),
    AgentVersionModel.deleteMany({ workspaceId }),
    WorkspaceModel.deleteOne({ workspaceId }),
  ]);
  return true;
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
