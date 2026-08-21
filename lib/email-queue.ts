import { randomUUID } from "node:crypto";

import { AutomationModel } from "@/models/automation";
import { AutomationWebhookEventModel, type AutomationWebhookEventRecord } from "@/models/automation-webhook-event";
import { ActiveRunConflictError } from "@/lib/task-run-control";
import { launchAutomation, launchEmailContinuation } from "@/lib/automation-execution";

const leaseDurationMs = 5 * 60_000;
const retryDelayMs = 30_000;

function ownerId(): string {
  return `email:${process.pid}:${randomUUID().slice(0, 8)}`;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

export type PendingEmailEvent = Pick<AutomationWebhookEventRecord, "automationId" | "eventId" | "executionId" | "contextText" | "parentSessionId" | "parentTaskId">;

export async function claimEmailEvent(input: { automationId: string; eventId: string; owner?: string; now?: Date }): Promise<AutomationWebhookEventRecord | null> {
  const now = input.now ?? new Date();
  const owner = input.owner ?? ownerId();
  return AutomationWebhookEventModel.findOneAndUpdate(
    {
      automationId: input.automationId,
      eventId: input.eventId,
      $or: [
        { dispatchStatus: "pending", $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { dispatchStatus: "processing", dispatchLeaseExpiresAt: { $lte: now } },
      ],
    },
    { $set: { dispatchStatus: "processing", dispatchLeaseOwner: owner, dispatchLeaseExpiresAt: new Date(now.getTime() + leaseDurationMs) }, $inc: { attemptCount: 1 } },
    { new: true },
  ).lean() as Promise<AutomationWebhookEventRecord | null>;
}

export async function markEmailEventLaunched(eventId: string, owner: string, input: { sessionId: string; taskId: string }): Promise<void> {
  await AutomationWebhookEventModel.updateOne(
    { eventId, dispatchStatus: "processing", dispatchLeaseOwner: owner },
    { $set: { dispatchStatus: "launched", sessionId: input.sessionId, taskId: input.taskId, dispatchLeaseOwner: null, dispatchLeaseExpiresAt: null, nextAttemptAt: null, error: null } },
  );
}

export async function requeueEmailEvent(eventId: string, owner: string, error?: string, now = new Date()): Promise<void> {
  await AutomationWebhookEventModel.updateOne(
    { eventId, dispatchStatus: "processing", dispatchLeaseOwner: owner },
    { $set: { dispatchStatus: "pending", dispatchLeaseOwner: null, dispatchLeaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + retryDelayMs), ...(error ? { error: error.slice(0, 2_000) } : {}) } },
  );
}

export async function failEmailEvent(eventId: string, owner: string, error: string): Promise<void> {
  await AutomationWebhookEventModel.updateOne(
    { eventId, dispatchStatus: "processing", dispatchLeaseOwner: owner },
    { $set: { status: "failed", dispatchStatus: "failed", dispatchLeaseOwner: null, dispatchLeaseExpiresAt: null, nextAttemptAt: null, error: error.slice(0, 2_000) } },
  );
}

async function dispatchClaimedEmailEvent(event: AutomationWebhookEventRecord, owner: string): Promise<{ ok: boolean; error?: string }> {
  const automation = await AutomationModel.findOne({ automationId: event.automationId, status: "active" }).lean();
  if (!automation) {
    await failEmailEvent(event.eventId, owner, "邮件入口已暂停或不存在");
    return { ok: false, error: "邮件入口已暂停或不存在" };
  }
  if (!event.contextText) {
    await failEmailEvent(event.eventId, owner, "邮件事件缺少可恢复的正文");
    return { ok: false, error: "邮件事件缺少可恢复的正文" };
  }
  try {
    const launched = event.parentTaskId && event.parentSessionId
      ? await launchEmailContinuation({ automation, taskId: event.parentTaskId, sourceSessionId: event.parentSessionId, executionId: event.executionId, contextText: event.contextText })
      : await launchAutomation({ automation, source: "email", executionId: event.executionId, contextText: event.contextText });
    await markEmailEventLaunched(event.eventId, owner, { sessionId: launched.session.id, taskId: launched.task.taskId });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "邮件任务启动失败";
    if (error instanceof ActiveRunConflictError) {
      await requeueEmailEvent(event.eventId, owner, message);
      return { ok: false, error: message };
    }
    await failEmailEvent(event.eventId, owner, message);
    return { ok: false, error: message };
  }
}

export async function dispatchEmailEventNow(input: { automationId: string; eventId: string }): Promise<{ claimed: boolean; ok: boolean; error?: string }> {
  const owner = ownerId();
  const event = await claimEmailEvent({ ...input, owner });
  if (!event) return { claimed: false, ok: false };
  return { claimed: true, ...(await dispatchClaimedEmailEvent(event, owner)) };
}

export async function dispatchPendingEmailEvents(input: { owner?: string; now?: Date; limit?: number } = {}) {
  const now = input.now ?? new Date();
  const owner = input.owner ?? ownerId();
  const limit = input.limit ?? 20;
  const results: Array<{ eventId: string; ok: boolean; error?: string }> = [];
  for (let index = 0; index < limit; index += 1) {
    const event = await AutomationWebhookEventModel.findOneAndUpdate(
      {
        dispatchStatus: "pending",
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      { $set: { dispatchStatus: "processing", dispatchLeaseOwner: owner, dispatchLeaseExpiresAt: new Date(now.getTime() + leaseDurationMs) }, $inc: { attemptCount: 1 } },
      { new: true, sort: { createdAt: 1 } },
    ).lean() as AutomationWebhookEventRecord | null;
    if (!event) break;
    results.push({ eventId: event.eventId, ...(await dispatchClaimedEmailEvent(event, owner)) });
  }
  return { claimed: results.length, results };
}

export async function createPendingEmailEvent(input: { automationId: string; eventId: string; executionId: string; payloadHash: string; contextText: string; parentTaskId?: string | null; parentSessionId?: string | null }): Promise<{ event: AutomationWebhookEventRecord; replayed: boolean }> {
  try {
    const event = await AutomationWebhookEventModel.create({
      automationId: input.automationId,
      eventId: input.eventId,
      payloadHash: input.payloadHash,
      executionId: input.executionId,
      contextText: input.contextText,
      parentTaskId: input.parentTaskId ?? null,
      parentSessionId: input.parentSessionId ?? null,
      dispatchStatus: "pending",
      status: "accepted",
    });
    return { event: event.toObject() as AutomationWebhookEventRecord, replayed: false };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await AutomationWebhookEventModel.findOne({ automationId: input.automationId, eventId: input.eventId }).lean();
    if (!existing) throw error;
    return { event: existing as AutomationWebhookEventRecord, replayed: true };
  }
}

