import type { ResolvedAgentApiKey } from "@/lib/agent-api-keys";
import { canReadProject, getProjectAccess } from "@/lib/project-access";
import { workspaceAllowed } from "@/lib/public-api";
import { RunModel } from "@/models/run";
import { TaskModel, type TaskRecord } from "@/models/task";

export async function findPublicTask(taskId: string, key: ResolvedAgentApiKey): Promise<TaskRecord | null> {
  const task = await TaskModel.findOne({ taskId }).lean();
  if (!task || !workspaceAllowed(key, task.workspaceId)) return null;
  if (task.projectId) {
    const access = await getProjectAccess(task.projectId, key.userId);
    return access && canReadProject(access.role) ? task : null;
  }
  return task.userId === key.userId ? task : null;
}

export async function findPublicArtifactTask(artifactId: string, key: ResolvedAgentApiKey) {
  const { SandboxArtifactModel } = await import("@/models/sandbox-artifact");
  const artifact = await SandboxArtifactModel.findOne({ artifactId }).lean();
  if (!artifact) return null;
  const run = await RunModel.findOne({ runId: artifact.runId }).lean();
  const task = run ? await findPublicTask(run.taskId, key) : null;
  return task && run ? { artifact, task, run } : null;
}
