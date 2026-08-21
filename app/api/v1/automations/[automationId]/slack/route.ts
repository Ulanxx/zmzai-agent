import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-error";
import { launchAutomation } from "@/lib/automation-execution";
import { normalizeSlackRequest, validateSlackRequest } from "@/lib/slack-adapter";
import { AutomationModel } from "@/models/automation";
import { AutomationExecutionModel } from "@/models/automation-execution";
import { AutomationWebhookEventModel } from "@/models/automation-webhook-event";
import { webhookPayloadHash, webhookPayloadMatches } from "@/lib/automation-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ automationId: string }> }) {
  const { automationId } = await context.params;
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > 64 * 1024) return apiError("SLACK_BODY_TOO_LARGE", 413, "Slack 请求不能超过 64 KiB");
  const automation = await AutomationModel.findOne({ automationId }).select("+webhookSecret").lean();
  if (!automation || automation.status !== "active") return apiError("SLACK_NOT_FOUND", 404, "Slack 入口不存在或已暂停");
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  const validation = validateSlackRequest({ encryptedSecret: automation.webhookSecret, timestamp, signature, body });
  if (validation) return apiError("SLACK_UNAUTHORIZED", 401, validation);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0] === "application/x-www-form-urlencoded" ? "urlencoded" : null;
  const inbound = normalizeSlackRequest(body, { eventId: contentType });
  if (!inbound) return NextResponse.json({ accepted: true, ignored: true }, { headers: { "cache-control": "no-store" } });
  if ("challenge" in inbound) return NextResponse.json({ challenge: inbound.challenge }, { headers: { "cache-control": "no-store" } });
  const eventId = inbound.eventId;
  const executionId = `aexec_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  try {
    await AutomationWebhookEventModel.create({ automationId, eventId, payloadHash: webhookPayloadHash(body), executionId, replyUrl: inbound.responseUrl ?? null, status: "accepted" });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate key")) throw error;
    const existing = await AutomationWebhookEventModel.findOne({ automationId, eventId }).lean();
    if (existing && !webhookPayloadMatches(existing.payloadHash, body)) return NextResponse.json({ code: "SLACK_EVENT_CONFLICT", error: "同一 event id 不能对应不同内容" }, { status: 409 });
    const execution = existing ? await AutomationExecutionModel.findOne({ executionId: existing.executionId }).lean() : null;
    return NextResponse.json({ accepted: true, replayed: true, execution_id: existing?.executionId ?? null, task_id: execution?.taskId ?? null }, { status: 202, headers: { "cache-control": "no-store" } });
  }
  const contextText = `[Slack 消息]\n频道: ${inbound.channel}\n用户: ${inbound.actor}\n内容:\n${inbound.text.slice(0, 48 * 1024)}`;
  try {
    const launched = await launchAutomation({ automation, source: "slack", executionId, contextText });
    await AutomationWebhookEventModel.updateOne({ automationId, eventId }, { $set: { sessionId: launched.session.id, taskId: launched.task.taskId } });
    return NextResponse.json({ accepted: true, replayed: false, execution_id: executionId, task_id: launched.task.taskId, run_id: launched.run.runId }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "Slack 任务启动失败";
    await AutomationWebhookEventModel.updateOne({ automationId, eventId }, { $set: { status: "failed", error: message } });
    throw error;
  }
}
