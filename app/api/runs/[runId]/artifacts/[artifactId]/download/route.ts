import { Readable } from "node:stream";

import { NextRequest } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { openArtifactStream } from "@/lib/artifact-storage";
import { getCurrentUser } from "@/lib/auth/session";
import { getTaskRun } from "@/lib/task-runs";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string; artifactId: string }> }) {
  void request;
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { runId, artifactId } = await context.params;
  // Ownership: the run must belong to the user, then the artifact to the run.
  if (!(await getTaskRun(user.id, runId))) return apiError("RUN_NOT_FOUND", 404, "Task Run 不存在");
  const artifact = await SandboxArtifactModel.findOne({ artifactId, runId, userId: user.id }).lean();
  if (!artifact || artifact.tooLarge || !artifact.gridFsFileId) return apiError("ARTIFACT_NOT_FOUND", 404, "产物不存在");

  const filename = artifact.sandboxPath.split("/").pop() ?? "artifact";
  const stream = openArtifactStream(artifact.gridFsFileId);
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    headers: {
      "Content-Type": artifact.contentType,
      "Content-Length": String(artifact.sizeBytes),
      "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store",
      "ETag": `"${artifact.sha256}"`,
    },
  });
}
