import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(12).optional(),
}).strict().refine((value) => !value.tags || new Set(value.tags.map((tag) => tag.toLowerCase())).size === value.tags.length, { message: "标签不能重复", path: ["tags"] });

export async function PATCH(request: NextRequest, context: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { artifactId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "成果更新请求格式不正确");
  const artifact = await SandboxArtifactModel.findOneAndUpdate({ artifactId, userId: user.id }, { $set: parsed.data }, { new: true }).lean();
  if (!artifact) return apiError("ARTIFACT_NOT_FOUND", 404, "成果不存在或无权访问");
  return NextResponse.json({ artifact }, { headers: { "cache-control": "no-store" } });
}
