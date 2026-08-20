import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { ProjectModel } from "@/models/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), description: z.string().trim().max(4_000).optional(), instructions: z.string().max(64 * 1024).optional() }).strict();

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const project = await ProjectModel.findOne({ projectId, userId: user.id }).lean();
  if (!project) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  const tasks = await TaskModel.find({ projectId, userId: user.id }).sort({ updatedAt: -1 }).lean();
  const runs = tasks.length ? await RunModel.find({ taskId: { $in: tasks.map((task) => task.taskId) }, userId: user.id }).sort({ createdAt: -1 }).lean() : [];
  return NextResponse.json({ project, tasks, runs }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "项目更新请求格式不正确");
  const project = await ProjectModel.findOneAndUpdate({ projectId, userId: user.id }, { $set: parsed.data }, { new: true }).lean();
  if (!project) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  return NextResponse.json({ project }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { projectId } = await context.params;
  const deleted = await ProjectModel.deleteOne({ projectId, userId: user.id });
  if (!deleted.deletedCount) return apiError("PROJECT_NOT_FOUND", 404, "项目不存在或无权访问");
  await TaskModel.updateMany({ projectId, userId: user.id }, { $set: { projectId: null } });
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
