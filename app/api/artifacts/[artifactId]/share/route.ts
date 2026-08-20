import { createHash, randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getServerEnvironment } from "@/config/env";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shareSchema = z.object({ expiresInDays: z.number().int().min(1).max(30).default(7) }).strict();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function POST(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { artifactId } = await context.params;
  const parsed = shareSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "分享请求格式不正确");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60_000);
  const artifact = await SandboxArtifactModel.findOneAndUpdate(
    { artifactId, userId: user.id, tooLarge: false, gridFsFileId: { $ne: null } },
    { $set: { shareTokenHash: hashToken(token), shareExpiresAt: expiresAt } },
    { new: true },
  ).lean();
  if (!artifact) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无法分享");
  const base = getServerEnvironment().APP_URL.replace(/\/$/, "");
  return NextResponse.json({ shareUrl: `${base}/share/${token}`, expiresAt: expiresAt.toISOString() }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { artifactId } = await context.params;
  const result = await SandboxArtifactModel.updateOne({ artifactId, userId: user.id }, { $set: { shareTokenHash: null, shareExpiresAt: null } });
  if (!result.matchedCount) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  return NextResponse.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
}
