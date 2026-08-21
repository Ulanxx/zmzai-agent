import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { unauthenticated } from "@/lib/api-error";
import { RunModel } from "@/models/run";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { TaskModel } from "@/models/task";
import { ProjectArtifactModel } from "@/models/project-artifact";
import { ProjectMemberModel } from "@/models/project-member";
import { getProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewableTypes = new Set(["text/html", "text/css", "text/javascript", "application/javascript", "text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"]);

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 100) || 100, 1), 200);
  const tag = request.nextUrl.searchParams.get("tag")?.trim();
  const projectId = request.nextUrl.searchParams.get("projectId")?.trim();
  const contentType = request.nextUrl.searchParams.get("contentType")?.trim().toLowerCase();
  const from = request.nextUrl.searchParams.get("from")?.trim();
  const to = request.nextUrl.searchParams.get("to")?.trim();
  const memberships = await ProjectMemberModel.find({ userId: user.id }).select({ projectId: 1 }).lean();
  const memberProjectIds = memberships.map((membership) => membership.projectId);
  const projectAccess = projectId ? await getProjectAccess(projectId, user.id) : null;
  if (projectId && !projectAccess) return NextResponse.json({ artifacts: [] }, { headers: { "cache-control": "no-store" } });
  const visibleProjectIds = projectId ? [projectId] : memberProjectIds;
  const projectReferenceRecords = visibleProjectIds.length ? await ProjectArtifactModel.find({ projectId: { $in: visibleProjectIds } }).select({ artifactId: 1 }).lean() : [];
  const projectReferenceIds = projectReferenceRecords.map((reference) => reference.artifactId);
  const visibleTaskIds = visibleProjectIds.length ? (await TaskModel.find({ projectId: { $in: visibleProjectIds } }).select({ taskId: 1 }).lean()).map((task) => task.taskId) : [];
  const visibleRunIds = visibleTaskIds.length ? (await RunModel.find({ taskId: { $in: visibleTaskIds } }).select({ runId: 1 }).lean()).map((run) => run.runId) : [];
  const visibilityClauses: Record<string, unknown>[] = [{ userId: user.id }];
  if (visibleRunIds.length) visibilityClauses.push({ runId: { $in: visibleRunIds } });
  if (projectReferenceIds.length) visibilityClauses.push({ artifactId: { $in: projectReferenceIds } });
  const records = await SandboxArtifactModel.find({
    ...(tag ? { tags: tag } : {}),
    ...(contentType ? { contentType: new RegExp(contentType.endsWith("/") ? `^${contentType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : `^${contentType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:;|$)`, "i") } : {}),
    ...(from || to ? { createdAt: { ...(from && !Number.isNaN(Date.parse(from)) ? { $gte: new Date(from) } : {}), ...(to && !Number.isNaN(Date.parse(to)) ? { $lte: new Date(to) } : {}) } } : {}),
    $or: visibilityClauses,
  }).sort({ createdAt: -1 }).limit(limit).lean();
  const runIds = [...new Set(records.map((record) => record.runId))];
  const runs = runIds.length ? await RunModel.find({ runId: { $in: runIds } }).select({ runId: 1, taskId: 1, sessionId: 1 }).lean() : [];
  const taskIds = [...new Set(runs.map((run) => run.taskId))];
  const tasks = taskIds.length ? await TaskModel.find({ taskId: { $in: taskIds } }).select({ taskId: 1, title: 1, projectId: 1 }).lean() : [];
  const runById = new Map(runs.map((run) => [run.runId, run]));
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const references = records.length ? await ProjectArtifactModel.find({ artifactId: { $in: records.map((record) => record.artifactId) } }).select({ artifactId: 1, projectId: 1 }).lean() : [];
  const referencesByArtifact = new Map<string, string[]>();
  for (const reference of references) referencesByArtifact.set(reference.artifactId, [...(referencesByArtifact.get(reference.artifactId) ?? []), reference.projectId]);
  return NextResponse.json({ artifacts: records.map((record) => {
    const run = runById.get(record.runId);
    const task = run ? taskById.get(run.taskId) : undefined;
    const contentType = record.contentType.split(";")[0]!.trim().toLowerCase();
    const base = run ? `/api/fw/sessions/${encodeURIComponent(run.sessionId)}/artifacts/${encodeURIComponent(record.artifactId)}` : null;
    return { artifactId: record.artifactId, title: record.title || record.sandboxPath.split("/").pop() || record.sandboxPath, path: record.sandboxPath, tags: record.tags ?? [], versionGroupId: record.versionGroupId ?? null, version: record.version ?? 1, qualityStatus: record.qualityStatus ?? "not_applicable", qualityResult: record.qualityResult ?? null, shared: Boolean(record.shareExpiresAt && record.shareExpiresAt > new Date()), shareExpiresAt: record.shareExpiresAt?.toISOString() ?? null, bytes: record.sizeBytes, contentType: record.contentType, createdAt: record.createdAt.toISOString(), taskId: task?.taskId ?? null, taskTitle: task?.title ?? null, projectId: task?.projectId ?? null, projectIds: [...new Set([...(task?.projectId ? [task.projectId] : []), ...(referencesByArtifact.get(record.artifactId) ?? [])])], downloadUrl: base ? `${base}/download` : null, previewUrl: base && previewableTypes.has(contentType) ? `${base}/preview` : null };
  }).filter((artifact) => !projectId || artifact.projectIds.includes(projectId)) }, { headers: { "cache-control": "no-store" } });
}
