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
  // —— Agent 配置（Workspace = 智能体）——
  prompt: string;
  steps: number;
  tools: string[];
  skillIds: string[];
  pluginIds: string[];
  connectorIds: string[];
  permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
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
  prompt?: string;
  steps?: number;
  tools?: string[];
  skillIds?: string[];
  pluginIds?: string[];
  connectorIds?: string[];
  permission?: unknown;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceSummary {
  // permission 从 mongoose lean 出来是 plain array，类型断言对齐。
  const permission = (Array.isArray(workspace.permission) ? workspace.permission : []) as Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
  return {
    id: workspace.workspaceId,
    name: workspace.name,
    description: workspace.description,
    currentRevisionId: workspace.currentRevisionId ?? null,
    defaultModel: workspace.defaultModel,
    approvalMode: workspace.approvalMode,
    prompt: workspace.prompt ?? "",
    steps: workspace.steps ?? 12,
    tools: workspace.tools ?? [],
    skillIds: workspace.skillIds ?? [],
    pluginIds: workspace.pluginIds ?? [],
    connectorIds: workspace.connectorIds ?? [],
    permission,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  };
}

export async function createWorkspace(input: { workspaceId: string; userId: string; name: string; description: string; defaultModel: string; prompt?: string }): Promise<WorkspaceSummary> {
  const workspace = await WorkspaceModel.create({
    workspaceId: input.workspaceId,
    userId: input.userId,
    name: input.name,
    description: input.description,
    defaultModel: input.defaultModel,
    approvalMode: "always",
    ...(input.prompt ? { prompt: input.prompt } : {}),
  });
  return toWorkspaceSummary(workspace);
}

export async function getWorkspace(userId: string, workspaceId: string): Promise<WorkspaceSummary | null> {
  const workspace = await WorkspaceModel.findOne({ userId, workspaceId }).lean();
  return workspace ? toWorkspaceSummary(workspace) : null;
}

export async function listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  // 确保用户至少有一个「通用」智能体（首次访问自动创建）。
  await ensureDefaultWorkspace(userId);
  // 按创建时间降序（新的在前），不随会话/Agent 活动跳动——updatedAt 会被
  // 运行中的 Agent 频繁刷新，按它排序会让列表顺序在浏览时乱跳。
  const workspaces = await WorkspaceModel.find({ userId }).sort({ createdAt: -1 }).lean();
  return workspaces.map(toWorkspaceSummary);
}

/** 确保用户至少有一个「通用」智能体。首次调用时创建，幂等。 */
export async function ensureDefaultWorkspace(userId: string): Promise<void> {
  const exists = await WorkspaceModel.exists({ userId, name: "通用" }).lean();
  if (exists) return;
  const { randomUUID } = await import("node:crypto");
  await WorkspaceModel.create({
    workspaceId: `ws_${randomUUID()}`,
    userId,
    name: "通用",
    description: "默认通用智能体，直接描述任务即可开始。",
    defaultModel: "gpt-5.6-luna",
    approvalMode: "always",
    prompt: "",
    steps: 12,
  });
}

/** 重命名/更新描述/更新智能体配置。 */
export async function updateWorkspace(userId: string, workspaceId: string, patch: {
  name?: string;
  description?: string;
  defaultModel?: string;
  prompt?: string;
  steps?: number;
  tools?: string[];
  skillIds?: string[];
  pluginIds?: string[];
  connectorIds?: string[];
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
}): Promise<WorkspaceSummary | null> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.defaultModel !== undefined) set.defaultModel = patch.defaultModel;
  if (patch.prompt !== undefined) set.prompt = patch.prompt;
  if (patch.steps !== undefined) set.steps = patch.steps;
  if (patch.tools !== undefined) set.tools = patch.tools;
  if (patch.skillIds !== undefined) set.skillIds = patch.skillIds;
  if (patch.pluginIds !== undefined) set.pluginIds = patch.pluginIds;
  if (patch.connectorIds !== undefined) set.connectorIds = patch.connectorIds;
  if (patch.permission !== undefined) set.permission = patch.permission;
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
    WorkspaceModel.deleteOne({ workspaceId }),
  ]);
  return true;
}

export async function listWorkspaceFiles(userId: string, workspaceId: string) {
  if (!(await WorkspaceModel.exists({ userId, workspaceId }))) return null;
  // 聚合视图：跨会话列出该 workspace 全部文件（配置页用），sessionId 标注归属。
  const files = await WorkspaceFileModel.find({ workspaceId }).sort({ path: 1 }).lean();
  return files.map((file) => ({ path: file.path, sessionId: file.sessionId, content: file.content, revisionId: file.revisionId, updatedAt: file.updatedAt.toISOString() }));
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
