import { Readable } from "node:stream";

import { apiError, unauthenticated } from "@/lib/api-error";
import { openArtifactStream } from "@/lib/artifact-storage";
import { getCurrentUser } from "@/lib/auth/session";
import { defaultStore } from "@/framework/core/runtime/runner";
import { findArtifactForSession } from "@/lib/artifact-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** FW artifact download (spec §10.2): the FW bash tool stores deliverables via
 *  the same GridFS pipeline as the legacy exec path, keyed by runId = session
 *  id. Streams with Content-Disposition: attachment. */
export async function GET(_: Request, context: { params: Promise<{ sessionId: string; artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId, artifactId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  if (!session || session.userId !== user.id) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");

  const artifact = await findArtifactForSession({ artifactId, sessionId, userId: user.id });
  if (!artifact || artifact.tooLarge || !artifact.gridFsFileId) return apiError("ARTIFACT_NOT_FOUND", 404, "产物不存在");

  const filename = artifact.sandboxPath.split("/").pop() ?? "artifact";
  const stream = openArtifactStream(artifact.gridFsFileId);
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  // RFC 5987：filename* 保留中文原名（此前非 ASCII 全替换成下划线，
  // 「季度汇报PPT_10页.pptx」下载成了「____PPT_10_.pptx」）；
  // filename 留 ASCII 兜底给不支持 filename* 的老客户端。
  const asciiFallback = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return new Response(webStream, {
    headers: {
      "Content-Type": artifact.contentType,
      "Content-Length": String(artifact.sizeBytes),
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
      "ETag": `"${artifact.sha256}"`,
    },
  });
}
