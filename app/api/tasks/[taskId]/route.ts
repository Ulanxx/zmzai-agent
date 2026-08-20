import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { readFrameworkEvents } from "@/framework/core/events/bus";
import { defaultStore } from "@/framework/core/runtime/runner";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const task = await TaskModel.findOne({ taskId, userId: user.id }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const runs = await RunModel.find({ taskId, userId: user.id }).sort({ createdAt: -1 }).limit(50).lean();
  const sessionId = runs[0]?.sessionId;
  const session = sessionId ? await defaultStore.getSession(sessionId) : null;
  const messages = sessionId ? await defaultStore.getMessages(sessionId) : [];
  const events = sessionId ? await readFrameworkEvents(sessionId, 0, 5_000) : [];
  return NextResponse.json({ task, runs, session, messages, events }, { headers: { "cache-control": "no-store" } });
}
