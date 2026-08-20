import { createHash } from "node:crypto";

import { ArtifactLineageModel } from "@/models/artifact-lineage";
import { RunModel } from "@/models/run";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

export function artifactTitle(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || "未命名成果";
}

export function qualityStatusFor(contentType: string, path: string): "not_applicable" | "pending" {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type === "text/html" || path.endsWith(".html") || path === "web_app.zip" ? "pending" : "not_applicable";
}

export async function reserveArtifactVersion(input: { userId: string; runId: string; path: string }): Promise<{ versionGroupId: string; version: number }> {
  const run = await RunModel.findOne({ runId: input.runId, userId: input.userId }).select({ taskId: 1 }).lean();
  const taskId = run?.taskId ?? input.runId;
  const lineageId = `alin_${createHash("sha256").update(`${input.userId}\u0000${taskId}\u0000${input.path}`).digest("hex").slice(0, 24)}`;
  const lineage = await ArtifactLineageModel.findOneAndUpdate(
    { lineageId },
    { $setOnInsert: { lineageId, userId: input.userId, taskId, path: input.path }, $inc: { nextVersion: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return { versionGroupId: lineageId, version: lineage?.nextVersion ?? 1 };
}

type QualityResult = { version: "v1"; status: "passed" | "failed"; checks: unknown[]; viewports: unknown[] };

function isQualityResult(value: unknown): value is QualityResult {
  return Boolean(value) && typeof value === "object" && (value as { version?: unknown }).version === "v1" && ((value as { status?: unknown }).status === "passed" || (value as { status?: unknown }).status === "failed") && Array.isArray((value as { checks?: unknown }).checks) && Array.isArray((value as { viewports?: unknown }).viewports);
}

/** QA is attached to the deliverable, not merely a transient tool card. The
 * result remains after refresh and lets the artifact center distinguish an
 * inspected web app from an unchecked file. */
export async function projectArtifactQuality(input: { sessionId: string; entryPath: string; result: unknown }): Promise<void> {
  if (!isQualityResult(input.result)) return;
  const run = await RunModel.findOne({ sessionId: input.sessionId }).sort({ createdAt: -1 }).lean();
  if (!run) return;
  await SandboxArtifactModel.updateMany(
    { runId: run.runId, sandboxPath: { $in: [input.entryPath, "web_app.zip"] } },
    { $set: { qualityStatus: input.result.status, qualityResult: input.result } },
  );
}
