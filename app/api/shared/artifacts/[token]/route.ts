import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { NextRequest, NextResponse } from "next/server";

import { openArtifactStream } from "@/lib/artifact-storage";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewableTypes = new Set(["text/html", "text/css", "text/javascript", "application/javascript", "text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"]);

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const artifact = await SandboxArtifactModel.findOne({ shareTokenHash: tokenHash, shareExpiresAt: { $gt: new Date() }, tooLarge: false, gridFsFileId: { $ne: null } }).select("+shareTokenHash").lean();
  if (!artifact || !artifact.gridFsFileId) return NextResponse.json({ error: "分享不存在或已过期" }, { status: 404, headers: { "cache-control": "no-store" } });
  const filename = artifact.sandboxPath.split("/").pop() ?? "artifact";
  const contentType = artifact.contentType.split(";")[0]!.trim().toLowerCase();
  const download = request.nextUrl.searchParams.get("download") === "1";
  const stream = openArtifactStream(artifact.gridFsFileId);
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    headers: {
      "Content-Type": artifact.contentType,
      "Content-Length": String(artifact.sizeBytes),
      ...(download ? { "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}` } : {}),
      "Cache-Control": "private, max-age=60",
      "Content-Security-Policy": previewableTypes.has(contentType) ? "sandbox allow-scripts allow-same-origin" : "sandbox",
      "Referrer-Policy": "no-referrer",
    },
  });
}
