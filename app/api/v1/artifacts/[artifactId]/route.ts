import { Readable } from "node:stream";

import { apiError } from "@/lib/api-error";
import { openArtifactStream } from "@/lib/artifact-storage";
import { findPublicArtifactTask } from "@/lib/public-task-access";
import { requireAgentApiKey } from "@/lib/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ artifactId: string }> }) {
  const authorized = await requireAgentApiKey(request, "artifacts:read");
  if ("response" in authorized) return authorized.response;
  const { artifactId } = await context.params;
  const resolved = await findPublicArtifactTask(artifactId, authorized.key);
  if (!resolved || resolved.artifact.tooLarge || !resolved.artifact.gridFsFileId) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  const filename = resolved.artifact.sandboxPath.split("/").pop() ?? "artifact";
  const stream = openArtifactStream(resolved.artifact.gridFsFileId);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: { "content-type": resolved.artifact.contentType, "content-length": String(resolved.artifact.sizeBytes), "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "cache-control": "no-store", etag: `\"${resolved.artifact.sha256}\"` } });
}
