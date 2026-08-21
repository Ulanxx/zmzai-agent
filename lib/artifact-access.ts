import { RunModel } from "@/models/run";
import { SandboxArtifactModel, type SandboxArtifactRecord } from "@/models/sandbox-artifact";
import { TaskModel } from "@/models/task";
import { ProjectArtifactModel } from "@/models/project-artifact";
import { getProjectAccess, type ProjectAccess } from "@/lib/project-access";

export async function getArtifactAccess(artifactId: string, userId: string): Promise<{ artifact: SandboxArtifactRecord; access: ProjectAccess | null } | null> {
  const artifact = await SandboxArtifactModel.findOne({ artifactId }).lean();
  if (!artifact) return null;
  const run = await RunModel.findOne({ runId: artifact.runId }).lean();
  const task = run ? await TaskModel.findOne({ taskId: run.taskId }).lean() : null;
  if (artifact.userId === userId) return { artifact, access: task?.projectId ? await getProjectAccess(task.projectId, userId) : null };
  if (task?.projectId) {
    const access = await getProjectAccess(task.projectId, userId);
    if (access) return { artifact, access };
  }
  const references = await ProjectArtifactModel.find({ artifactId }).select({ projectId: 1 }).lean();
  for (const reference of references) {
    const access = await getProjectAccess(reference.projectId, userId);
    if (access) return { artifact, access };
  }
  return null;
}

/** Resolves both legacy session-keyed artifacts and new product Run-keyed
 * artifacts without exposing artifacts from another user's session. */
export async function findArtifactForSession(input: { userId: string; sessionId: string; artifactId: string }) {
  const artifact = await SandboxArtifactModel.findOne({ artifactId: input.artifactId, userId: input.userId }).lean();
  if (!artifact) return null;
  if (artifact.runId === input.sessionId) return artifact;
  const run = await RunModel.findOne({ runId: artifact.runId, sessionId: input.sessionId, userId: input.userId }).select({ _id: 1 }).lean();
  return run ? artifact : null;
}
