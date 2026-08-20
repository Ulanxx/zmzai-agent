import { RunModel } from "@/models/run";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

/** Resolves both legacy session-keyed artifacts and new product Run-keyed
 * artifacts without exposing artifacts from another user's session. */
export async function findArtifactForSession(input: { userId: string; sessionId: string; artifactId: string }) {
  const artifact = await SandboxArtifactModel.findOne({ artifactId: input.artifactId, userId: input.userId }).lean();
  if (!artifact) return null;
  if (artifact.runId === input.sessionId) return artifact;
  const run = await RunModel.findOne({ runId: artifact.runId, sessionId: input.sessionId, userId: input.userId }).select({ _id: 1 }).lean();
  return run ? artifact : null;
}
