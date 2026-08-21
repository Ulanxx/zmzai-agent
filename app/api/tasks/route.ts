import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { unauthenticated } from "@/lib/api-error";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { ProjectMemberModel } from "@/models/project-member";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  const status = request.nextUrl.searchParams.get("status")?.trim();
  const memberships = await ProjectMemberModel.find({ userId: user.id }).select({ projectId: 1 }).lean();
  const projectIds = memberships.map((membership) => membership.projectId);
  const query: Record<string, unknown> = projectIds.length ? { $or: [{ userId: user.id }, { projectId: { $in: projectIds } }] } : { userId: user.id };
  if (workspaceId) query.workspaceId = workspaceId;
  if (status) query.status = status;
  const tasks = await TaskModel.find(query).sort({ updatedAt: -1 }).limit(100).lean();
  const taskIds = tasks.map((task) => task.taskId);
  const runs = taskIds.length ? await RunModel.find({ taskId: { $in: taskIds } }).sort({ createdAt: -1 }).lean() : [];
  const latest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (!latest.has(run.taskId)) latest.set(run.taskId, run);
  return NextResponse.json({ tasks: tasks.map((task) => ({ task, latestRun: latest.get(task.taskId) ?? null })) }, { headers: { "cache-control": "no-store" } });
}
