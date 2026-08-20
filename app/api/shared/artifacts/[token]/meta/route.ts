import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { SandboxArtifactModel } from "@/models/sandbox-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewableTypes = new Set(["text/html", "text/css", "text/javascript", "application/javascript", "text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"]);

export async function GET(_: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const artifact = await SandboxArtifactModel.findOne({ shareTokenHash: tokenHash, shareExpiresAt: { $gt: new Date() }, tooLarge: false, gridFsFileId: { $ne: null } }).select({ title: 1, sandboxPath: 1, contentType: 1, sizeBytes: 1, version: 1, shareExpiresAt: 1 }).lean();
  if (!artifact) return NextResponse.json({ error: "分享不存在或已过期" }, { status: 404, headers: { "cache-control": "no-store" } });
  const contentType = artifact.contentType.split(";")[0]!.trim().toLowerCase();
  return NextResponse.json({ artifact: { title: artifact.title || artifact.sandboxPath, path: artifact.sandboxPath, contentType: artifact.contentType, bytes: artifact.sizeBytes, version: artifact.version ?? 1, previewable: previewableTypes.has(contentType), expiresAt: artifact.shareExpiresAt?.toISOString() ?? null } }, { headers: { "cache-control": "no-store" } });
}
