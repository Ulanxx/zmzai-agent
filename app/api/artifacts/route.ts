import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { unauthenticated } from "@/lib/api-error";
import { RunModel } from "@/models/run";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewableTypes = new Set(["text/html", "text/css", "text/javascript", "application/javascript", "text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"]);

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 100) || 100, 1), 200);
  const records = await SandboxArtifactModel.find({ userId: user.id }).sort({ createdAt: -1 }).limit(limit).lean();
  const runIds = [...new Set(records.map((record) => record.runId))];
  const runs = runIds.length ? await RunModel.find({ runId: { $in: runIds }, userId: user.id }).select({ runId: 1, taskId: 1, sessionId: 1 }).lean() : [];
  const taskIds = [...new Set(runs.map((run) => run.taskId))];
  const tasks = taskIds.length ? await TaskModel.find({ taskId: { $in: taskIds }, userId: user.id }).select({ taskId: 1, title: 1, projectId: 1 }).lean() : [];
  const runById = new Map(runs.map((run) => [run.runId, run]));
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  return NextResponse.json({ artifacts: records.map((record) => {
    const run = runById.get(record.runId);
    const task = run ? taskById.get(run.taskId) : undefined;
    const contentType = record.contentType.split(";")[0]!.trim().toLowerCase();
    const base = run ? `/api/fw/sessions/${encodeURIComponent(run.sessionId)}/artifacts/${encodeURIComponent(record.artifactId)}` : null;
    return { artifactId: record.artifactId, path: record.sandboxPath, bytes: record.sizeBytes, contentType: record.contentType, createdAt: record.createdAt.toISOString(), taskId: task?.taskId ?? null, taskTitle: task?.title ?? null, projectId: task?.projectId ?? null, downloadUrl: base ? `${base}/download` : null, previewUrl: base && previewableTypes.has(contentType) ? `${base}/preview` : null };
  }) }, { headers: { "cache-control": "no-store" } });
}
