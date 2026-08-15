import { Readable } from "node:stream";

import { apiError, unauthenticated } from "@/lib/api-error";
import { openArtifactStream } from "@/lib/artifact-storage";
import { getCurrentUser } from "@/lib/auth/session";
import { defaultStore } from "@/framework/core/runtime/runner";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewableTypes = new Set([
  "text/html",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/css",
  // pptx：返回原始字节，前端 Canvas 用 pptx 渲染器展示（非 iframe 内嵌）
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/** Inline preview (spec §10.2 step 2): serves previewable types with their
 *  real Content-Type and NO attachment disposition, so the workbench can
 *  iframe them. Falls back to 404 for non-previewable types (client then
 *  offers only the download button). */
export async function GET(_: Request, context: { params: Promise<{ sessionId: string; artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId, artifactId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session || session.userId !== user.id) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");

  const artifact = await SandboxArtifactModel.findOne({ artifactId, runId: sessionId, userId: user.id }).lean();
  if (!artifact || artifact.tooLarge || !artifact.gridFsFileId) return apiError("ARTIFACT_NOT_FOUND", 404, "产物不存在");
  const contentType = artifact.contentType.split(";")[0]!.trim().toLowerCase();
  if (!previewableTypes.has(contentType)) return apiError("NOT_PREVIEWABLE", 404, "该产物类型不支持在线预览");

  const stream = openArtifactStream(artifact.gridFsFileId);
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    headers: {
      "Content-Type": artifact.contentType,
      "Content-Length": String(artifact.sizeBytes),
      "Cache-Control": "no-store",
      // Sandboxed iframe still applies; keep scripts same-origin only.
      "Content-Security-Policy": "sandbox allow-scripts allow-same-origin",
      "ETag": `"${artifact.sha256}"`,
    },
  });
}
