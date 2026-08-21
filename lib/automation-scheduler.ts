import { randomUUID } from "node:crypto";

import { AutomationModel, type AutomationRecord } from "@/models/automation";
import { nextScheduledAt } from "@/lib/automation-schedule";
import { launchAutomation } from "@/lib/automation-execution";
import { dispatchPendingEmailEvents } from "@/lib/email-queue";

const leaseDurationMs = 5 * 60_000;

export function schedulerOwner(): string {
  return `scheduler:${process.pid}:${randomUUID().slice(0, 8)}`;
}

export async function claimDueAutomations(input: { owner: string; now?: Date; limit?: number }): Promise<AutomationRecord[]> {
  const now = input.now ?? new Date();
  const claimed: AutomationRecord[] = [];
  for (let index = 0; index < (input.limit ?? 10); index += 1) {
    const record = await AutomationModel.findOneAndUpdate(
      {
        status: "active",
        nextRunAt: { $ne: null, $lte: now },
        $or: [{ schedulerLeaseExpiresAt: null }, { schedulerLeaseExpiresAt: { $lt: now } }],
      },
      { $set: { lastRunStatus: "running", lastError: null, schedulerLeaseOwner: input.owner, schedulerLeaseExpiresAt: new Date(now.getTime() + leaseDurationMs) } },
      { new: true, sort: { nextRunAt: 1 } },
    ).lean();
    if (!record) break;
    claimed.push(record as AutomationRecord);
  }
  return claimed;
}

export async function dispatchDueAutomations(input: { owner: string; now?: Date; limit?: number }) {
  const now = input.now ?? new Date();
  const claimed = await claimDueAutomations({ ...input, now });
  const results: Array<{ automationId: string; ok: boolean; sessionId?: string; error?: string }> = [];
  for (const automation of claimed) {
    try {
      const nextRunAt = nextScheduledAt(automation.schedule, now, automation.timezone);
      const launched = await launchAutomation({ automation, source: "schedule" });
      await AutomationModel.updateOne(
        { automationId: automation.automationId, schedulerLeaseOwner: input.owner },
        { $set: { nextRunAt, schedulerLeaseOwner: null, schedulerLeaseExpiresAt: null, lastRunTaskId: launched.task.taskId, lastRunId: launched.run.runId } },
      );
      results.push({ automationId: automation.automationId, ok: true, sessionId: launched.session.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动化启动失败";
      await AutomationModel.updateOne(
        { automationId: automation.automationId, schedulerLeaseOwner: input.owner },
        { $set: { lastRunStatus: "failed", lastError: message.slice(0, 2_000), nextRunAt: nextScheduledAt(automation.schedule, now, automation.timezone), schedulerLeaseOwner: null, schedulerLeaseExpiresAt: null } },
      );
      results.push({ automationId: automation.automationId, ok: false, error: message });
    }
  }
  const email = await dispatchPendingEmailEvents({ owner: `${input.owner}:email`, now, limit: input.limit });
  return { claimed: claimed.length, results, email };
}

export async function initializeAutomationSchedule(automation: { schedule: string; timezone: string }, now = new Date()): Promise<Date | null> {
  return nextScheduledAt(automation.schedule, now, automation.timezone);
}
