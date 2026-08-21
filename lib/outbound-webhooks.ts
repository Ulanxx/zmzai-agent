import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { decryptConnectorHeaders, encryptConnectorHeaders } from "@/lib/connector-secrets";
import { assertPublicConnectorTarget } from "@/lib/workspace-connectors";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";
import { WebhookDeliveryModel } from "@/models/webhook-delivery";
import { WebhookSubscriptionModel } from "@/models/webhook-subscription";

export const outboundWebhookEvents = ["task.succeeded", "task.failed", "task.cancelled"] as const;
export type OutboundWebhookEvent = (typeof outboundWebhookEvents)[number];
const maxAttempts = 6;
const leaseMs = 45_000;

export function generateOutboundWebhookSecret(): { plaintext: string; encrypted: string; prefix: string } {
  const plaintext = `whs_${randomBytes(32).toString("base64url")}`;
  return { plaintext, encrypted: encryptConnectorHeaders({ secret: plaintext }), prefix: plaintext.slice(0, 16) };
}

export function outboundWebhookSignature(secret: string, timestamp: string, deliveryId: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.${body}`, "utf8").digest("hex")}`;
}

function eventPayload(input: { eventType: OutboundWebhookEvent; task: { taskId: string; workspaceId: string; projectId?: string | null; title: string; status: string; source?: string }; run: { runId: string; status: string; terminalReason?: string | null; startedAt?: Date | null; finishedAt?: Date | null } }) {
  return { id: `evt_${randomUUID().replaceAll("-", "").slice(0, 20)}`, type: input.eventType, occurred_at: new Date().toISOString(), data: { task_id: input.task.taskId, run_id: input.run.runId, workspace_id: input.task.workspaceId, project_id: input.task.projectId ?? null, title: input.task.title, source: input.task.source ?? "chat", status: input.run.status, terminal_reason: input.run.terminalReason ?? null, started_at: input.run.startedAt?.toISOString() ?? null, finished_at: input.run.finishedAt?.toISOString() ?? null } };
}

export async function enqueueTaskWebhookEvent(input: { sessionId: string; eventType: OutboundWebhookEvent }): Promise<number> {
  const run = await RunModel.findOne({ sessionId: input.sessionId }).sort({ createdAt: -1 }).lean();
  const task = run ? await TaskModel.findOne({ taskId: run.taskId }).lean() : null;
  if (!run || !task) return 0;
  const subscriptions = await WebhookSubscriptionModel.find({ workspaceId: task.workspaceId, status: "active", events: input.eventType }).select({ subscriptionId: 1 }).lean();
  let queued = 0;
  for (const subscription of subscriptions) {
    try {
      await WebhookDeliveryModel.create({ deliveryId: `whd_${randomUUID().replaceAll("-", "").slice(0, 20)}`, subscriptionId: subscription.subscriptionId, workspaceId: task.workspaceId, eventType: input.eventType, taskId: task.taskId, runId: run.runId, payload: eventPayload({ eventType: input.eventType, task, run }), status: "pending", attempts: 0, nextAttemptAt: new Date() });
      queued += 1;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate key")) throw error;
    }
  }
  return queued;
}

function retryAt(attempt: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(30 * 60_000, 1_000 * 2 ** Math.max(0, attempt - 1)));
}

export async function dispatchDueWebhookDeliveries(input: { limit?: number; now?: Date } = {}): Promise<{ claimed: number; delivered: number; failed: number }> {
  const now = input.now ?? new Date();
  let claimed = 0; let delivered = 0; let failed = 0;
  for (let index = 0; index < (input.limit ?? 20); index += 1) {
    const delivery = await WebhookDeliveryModel.findOneAndUpdate({ status: { $in: ["pending", "delivering"] }, nextAttemptAt: { $lte: now }, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: now } }] }, { $set: { status: "delivering", leaseExpiresAt: new Date(now.getTime() + leaseMs) }, $inc: { attempts: 1 } }, { new: true, sort: { nextAttemptAt: 1 } }).lean();
    if (!delivery) break;
    claimed += 1;
    const subscription = await WebhookSubscriptionModel.findOne({ subscriptionId: delivery.subscriptionId, status: "active" }).select("+encryptedSecret").lean();
    if (!subscription) {
      await WebhookDeliveryModel.updateOne({ deliveryId: delivery.deliveryId, status: "delivering" }, { $set: { status: "failed", lastError: "Webhook 订阅已停用或删除", leaseExpiresAt: null } });
      failed += 1;
      continue;
    }
    const timestamp = new Date().toISOString();
    const body = JSON.stringify(delivery.payload);
    try {
      await assertPublicConnectorTarget(subscription.url);
      const secret = decryptConnectorHeaders(subscription.encryptedSecret).secret;
      if (!secret) throw new Error("Webhook 密钥无效");
      const response = await fetch(subscription.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "ZMZAI-Agent-Webhooks/1.0", "x-zmzai-webhook-id": delivery.deliveryId, "x-zmzai-webhook-timestamp": timestamp, "x-zmzai-webhook-signature": outboundWebhookSignature(secret, timestamp, delivery.deliveryId, body) }, body, redirect: "error", signal: AbortSignal.timeout(15_000), cache: "no-store" });
      if (!response.ok) throw new Error(`远端返回 ${response.status}`);
      await WebhookDeliveryModel.updateOne({ deliveryId: delivery.deliveryId, status: "delivering" }, { $set: { status: "delivered", deliveredAt: new Date(), responseStatus: response.status, lastError: null, leaseExpiresAt: null } });
      await WebhookSubscriptionModel.updateOne({ subscriptionId: subscription.subscriptionId }, { $set: { lastDeliveredAt: new Date(), lastError: null } });
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "Webhook 投递失败";
      const terminal = delivery.attempts >= maxAttempts;
      await WebhookDeliveryModel.updateOne({ deliveryId: delivery.deliveryId, status: "delivering" }, { $set: { status: terminal ? "failed" : "pending", lastError: message, nextAttemptAt: terminal ? now : retryAt(delivery.attempts, now), leaseExpiresAt: null } });
      await WebhookSubscriptionModel.updateOne({ subscriptionId: subscription.subscriptionId }, { $set: { lastError: message } });
      if (terminal) failed += 1;
    }
  }
  return { claimed, delivered, failed };
}
