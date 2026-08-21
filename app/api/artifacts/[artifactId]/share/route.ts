import { createHash, randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getServerEnvironment } from "@/config/env";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { getArtifactAccess } from "@/lib/artifact-access";
import { canEditProject } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 分钟级短时分享（5–60 分钟）用于 web_app 临时预览（设计规格：默认 30 分钟过期）；与天数二选一。
const shareSchema = z
  .object({ expiresInDays: z.number().int().min(1).max(30).optional(), expiresInMinutes: z.number().int().min(5).max(60).optional() })
  .strict()
  .refine((body) => !(body.expiresInDays != null && body.expiresInMinutes != null), { message: "expiresInDays 与 expiresInMinutes 只能提供其中一个" });
const DEFAULT_SHARE_TTL_DAYS = 7;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function POST(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { artifactId } = await context.params;
  const parsed = shareSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "分享请求格式不正确");
  const artifactAccess = await getArtifactAccess(artifactId, user.id);
  if (!artifactAccess) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  if (artifactAccess.access && !canEditProject(artifactAccess.access.role)) return apiError("FORBIDDEN", 403, "当前角色不能分享成果");
  const token = randomBytes(32).toString("base64url");
  const ttlMs = parsed.data.expiresInMinutes != null ? parsed.data.expiresInMinutes * 60_000 : (parsed.data.expiresInDays ?? DEFAULT_SHARE_TTL_DAYS) * 24 * 60 * 60_000;
  const expiresAt = new Date(Date.now() + ttlMs);
  const artifact = await SandboxArtifactModel.findOneAndUpdate(
    { artifactId, userId: artifactAccess.artifact.userId, tooLarge: false, gridFsFileId: { $ne: null } },
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
  const artifactAccess = await getArtifactAccess(artifactId, user.id);
  if (!artifactAccess) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  if (artifactAccess.access && !canEditProject(artifactAccess.access.role)) return apiError("FORBIDDEN", 403, "当前角色不能撤销成果分享");
  const result = await SandboxArtifactModel.updateOne({ artifactId, userId: artifactAccess.artifact.userId }, { $set: { shareTokenHash: null, shareExpiresAt: null } });
  if (!result.matchedCount) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  return NextResponse.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
}
