import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/api-error";
import { launchAutomation } from "@/lib/automation-execution";
import { validateAutomationWebhook, webhookPayloadHash, webhookPayloadMatches } from "@/lib/automation-webhook";
import { AutomationModel } from "@/models/automation";
import { AutomationExecutionModel } from "@/models/automation-execution";
import { AutomationWebhookEventModel } from "@/models/automation-webhook-event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxBodyBytes = 64 * 1024;

export async function POST(request: NextRequest, context: { params: Promise<{ automationId: string }> }) {
  const { automationId } = await context.params;
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) return apiError("WEBHOOK_BODY_TOO_LARGE", 413, "Webhook body 不能超过 64 KiB");
  const automation = await AutomationModel.findOne({ automationId }).select("+webhookSecret").lean();
  if (!automation || automation.status !== "active") return apiError("WEBHOOK_NOT_FOUND", 404, "Webhook 不存在或已暂停");
  const eventId = request.headers.get("x-zmzai-event-id");
  const validation = validateAutomationWebhook({ encryptedSecret: automation.webhookSecret, timestamp: request.headers.get("x-zmzai-timestamp"), eventId, signature: request.headers.get("x-zmzai-signature"), body });
  if (validation) return apiError("WEBHOOK_UNAUTHORIZED", 401, validation);
  const safeEventId = eventId!;
  const executionId = `aexec_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  try {
    await AutomationWebhookEventModel.create({ automationId, eventId: safeEventId, payloadHash: webhookPayloadHash(body), executionId, status: "accepted" });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate key")) throw error;
    const existing = await AutomationWebhookEventModel.findOne({ automationId, eventId: safeEventId }).lean();
    if (existing && !webhookPayloadMatches(existing.payloadHash, body)) return apiError("WEBHOOK_EVENT_CONFLICT", 409, "同一 event id 不能对应不同内容");
    const execution = existing ? await AutomationExecutionModel.findOne({ executionId: existing.executionId }).lean() : null;
    return NextResponse.json({ accepted: true, replayed: true, execution_id: existing?.executionId ?? null, task_id: execution?.taskId ?? null, status: execution?.status ?? existing?.status ?? "accepted" }, { status: 202, headers: { "cache-control": "no-store" } });
  }
  let payload: unknown;
  try { payload = body ? JSON.parse(body) : null; } catch { payload = { raw: body }; }
  const contextText = `[Webhook 事件]\nevent_id: ${safeEventId}\npayload:\n${JSON.stringify(payload).slice(0, 48 * 1024)}`;
  try {
    const launched = await launchAutomation({ automation, source: "webhook", executionId, contextText });
    await AutomationWebhookEventModel.updateOne({ automationId, eventId: safeEventId }, { $set: { sessionId: launched.session.id, taskId: launched.task.taskId } });
    return NextResponse.json({ accepted: true, replayed: false, execution_id: executionId, task_id: launched.task.taskId, run_id: launched.run.runId }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "Webhook 启动失败";
    await AutomationWebhookEventModel.updateOne({ automationId, eventId: safeEventId }, { $set: { status: "failed", error: message } });
    throw error;
  }
}
