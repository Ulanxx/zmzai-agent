import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-error";
import { normalizeEmailRequest, validateEmailRequest } from "@/lib/email-adapter";
import { webhookPayloadHash, webhookPayloadMatches } from "@/lib/automation-webhook";
import { AutomationModel } from "@/models/automation";
import { AutomationExecutionModel } from "@/models/automation-execution";
import { AutomationWebhookEventModel } from "@/models/automation-webhook-event";
import { createPendingEmailEvent, dispatchEmailEventNow } from "@/lib/email-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ automationId: string }> }) {
  const { automationId } = await context.params;
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > 256 * 1024) return apiError("EMAIL_BODY_TOO_LARGE", 413, "邮件请求不能超过 256 KiB");
  const automation = await AutomationModel.findOne({ automationId }).select("+webhookSecret").lean();
  if (!automation || automation.status !== "active") return apiError("EMAIL_NOT_FOUND", 404, "邮件入口不存在或已暂停");
  const messageId = request.headers.get("x-zmzai-email-id");
  const validation = validateEmailRequest({ encryptedSecret: automation.webhookSecret, timestamp: request.headers.get("x-zmzai-email-timestamp"), messageId, signature: request.headers.get("x-zmzai-email-signature"), body });
  if (validation) return apiError("EMAIL_UNAUTHORIZED", 401, validation);
  const inbound = normalizeEmailRequest(body);
  if (!inbound || inbound.messageId !== messageId) return apiError("EMAIL_INVALID_BODY", 400, "邮件内容格式不正确");
  const eventId = `email:${inbound.messageId}`;
  const contextText = `[邮件消息]\n发件人: ${inbound.from}\n收件人: ${inbound.to}\n主题: ${inbound.subject}\n回复链: ${inbound.inReplyTo ?? "新线程"}\n正文:\n${inbound.text.slice(0, 180 * 1024)}`;
  const replyIds = [inbound.inReplyTo, ...(inbound.references ?? [])].filter((value): value is string => Boolean(value));
  const parentEvent = replyIds.length
    ? await AutomationWebhookEventModel.findOne({ automationId, eventId: { $in: replyIds.map((value) => `email:${value}`) }, taskId: { $ne: null } }).sort({ createdAt: -1 }).lean()
    : null;
  const executionId = `aexec_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const created = await createPendingEmailEvent({
    automationId,
    eventId,
    payloadHash: webhookPayloadHash(body),
    executionId,
    contextText,
    parentTaskId: parentEvent?.taskId ?? null,
    parentSessionId: parentEvent?.sessionId ?? null,
  });
  if (created.replayed) {
    if (!webhookPayloadMatches(created.event.payloadHash, body)) return NextResponse.json({ code: "EMAIL_EVENT_CONFLICT", error: "同一 message id 不能对应不同内容" }, { status: 409 });
    const execution = await AutomationExecutionModel.findOne({ executionId: created.event.executionId }).lean();
    return NextResponse.json({ accepted: true, replayed: true, pending: ["pending", "processing"].includes(created.event.dispatchStatus), execution_id: created.event.executionId, task_id: execution?.taskId ?? created.event.taskId ?? null }, { status: 202, headers: { "cache-control": "no-store" } });
  }
  const result = await dispatchEmailEventNow({ automationId, eventId });
  if (!result.ok && result.error && !result.error.includes("仍有") && !result.error.includes("不能创建新的 Run")) throw new Error(result.error);
  const launched = await AutomationExecutionModel.findOne({ executionId }).lean();
  const event = await AutomationWebhookEventModel.findOne({ automationId, eventId }).lean();
  return NextResponse.json({ accepted: true, replayed: false, pending: event?.dispatchStatus !== "launched", execution_id: executionId, task_id: launched?.taskId ?? event?.taskId ?? null, run_id: launched?.runId ?? null }, { status: 202, headers: { "cache-control": "no-store" } });
}
