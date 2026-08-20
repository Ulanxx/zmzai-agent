import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { defaultStore, createFrameworkSession } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { getCurrentUser } from "@/lib/auth/session";
import { apiError, unauthenticated } from "@/lib/api-error";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { createRunForTask, createTaskForSession } from "@/lib/task-run-control";
import { AutomationModel } from "@/models/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ automationId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { automationId } = await context.params;
  const automation = await AutomationModel.findOne({ automationId, userId: user.id }).lean();
  if (!automation) return apiError("AUTOMATION_NOT_FOUND", 404, "自动化不存在或无权访问");
  if (automation.status !== "active") return apiError("AUTOMATION_PAUSED", 409, "自动化已暂停");
  let claim;
  try {
    claim = await claimIdempotency({ userId: user.id, scope: "automation.run", key: request.headers.get("idempotency-key"), body: { automationId }, resourceId: `ses_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
  const existing = claim.replayed ? await defaultStore.getSession(claim.resourceId) : null;
  if (existing) return NextResponse.json({ session: existing, replayed: true }, { status: 202, headers: { "cache-control": "no-store" } });
  const session = await createFrameworkSession({ id: claim.resourceId, store: defaultStore, userId: user.id, workspaceId: automation.workspaceId, agent: "通用", model: { providerId: "relay", modelId: "gpt-5.6-luna" }, prompt: automation.goal, title: automation.name });
  const task = await createTaskForSession({ session, goal: automation.goal, title: automation.name });
  const run = await createRunForTask({ task, session });
  await AutomationModel.updateOne({ automationId, userId: user.id }, { $set: { lastRunAt: new Date() } });
  const result = await getFrameworkRunner().prompt(session.id, { text: automation.goal });
  return NextResponse.json({ session, task, run, queued: result.queued }, { status: 202, headers: { "cache-control": "no-store" } });
}
