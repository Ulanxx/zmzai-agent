import { ProjectMemberModel } from "@/models/project-member";
import { ProjectModel } from "@/models/project";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";

export type ProjectRole = "owner" | "editor" | "member" | "viewer";
export type ProjectAccess = { project: { projectId: string; workspaceId: string; userId: string; [key: string]: unknown }; role: ProjectRole };

export async function getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess | null> {
  const project = await ProjectModel.findOne({ projectId }).lean();
  if (!project) return null;
  if (project.userId === userId) return { project, role: "owner" };
  const member = await ProjectMemberModel.findOne({ projectId, userId }).select({ role: 1 }).lean();
  return member ? { project, role: member.role as Exclude<ProjectRole, "owner"> } : null;
}

export function canReadProject(role: ProjectRole): boolean {
  return ["owner", "editor", "member", "viewer"].includes(role);
}

export function canRunProject(role: ProjectRole): boolean {
  return role !== "viewer";
}

export function canEditProject(role: ProjectRole): boolean {
  return role === "owner" || role === "editor";
}

export function canManageMembers(role: ProjectRole): boolean {
  return role === "owner";
}

export async function getSessionProjectAccess(sessionId: string, userId: string): Promise<ProjectAccess | null> {
  const run = await RunModel.findOne({ sessionId }).sort({ createdAt: -1 }).lean();
  const task = run ? await TaskModel.findOne({ taskId: run.taskId }).select({ projectId: 1 }).lean() : null;
  return task?.projectId ? getProjectAccess(task.projectId, userId) : null;
}
