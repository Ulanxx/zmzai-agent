import { randomUUID } from "node:crypto";

import { defaultStore, createFrameworkSession } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { AutomationExecutionModel } from "@/models/automation-execution";
import type { AutomationRecord } from "@/models/automation";
import { createRunForTask, createTaskForSession } from "@/lib/task-run-control";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export async function launchAutomation(input: { automation: AutomationRecord; source: "manual" | "schedule" | "webhook"; sessionId?: string; executionId?: string }) {
  const session = await createFrameworkSession({
    id: input.sessionId ?? id("ses"),
    store: defaultStore,
    userId: input.automation.userId,
    workspaceId: input.automation.workspaceId,
    agent: "通用",
    model: { providerId: "relay", modelId: "gpt-5.6-luna" },
    prompt: input.automation.goal,
    title: input.automation.name,
  });
  const task = await createTaskForSession({ session, goal: input.automation.goal, title: input.automation.name });
  const run = await createRunForTask({ task, session });
  const execution = await AutomationExecutionModel.create({
    executionId: input.executionId ?? id("aexec"),
    automationId: input.automation.automationId,
    userId: input.automation.userId,
    workspaceId: input.automation.workspaceId,
    taskId: task.taskId,
    runId: run.runId,
    sessionId: session.id,
    source: input.source,
    status: "queued",
  });
  await import("@/models/automation").then(({ AutomationModel }) => AutomationModel.updateOne(
    { automationId: input.automation.automationId, userId: input.automation.userId },
    { $set: { lastRunStatus: "running", lastError: null, lastRunAt: new Date(), lastRunTaskId: task.taskId, lastRunId: run.runId } },
  ));
  try {
    const result = await getFrameworkRunner().prompt(session.id, { text: input.automation.goal });
    await AutomationExecutionModel.updateOne({ executionId: execution.executionId, status: "queued" }, { $set: { status: "running", startedAt: new Date() } });
    return { session, task, run, execution: { ...execution.toObject(), status: "running" }, queued: result.queued };
  } catch (error) {
    const message = error instanceof Error ? error.message : "自动化启动失败";
    await AutomationExecutionModel.updateOne({ executionId: execution.executionId }, { $set: { status: "failed", error: message.slice(0, 2_000), finishedAt: new Date() } });
    await import("@/models/automation").then(({ AutomationModel }) => AutomationModel.updateOne(
      { automationId: input.automation.automationId, userId: input.automation.userId },
      { $set: { lastRunStatus: "failed", lastError: message.slice(0, 2_000) } },
    ));
    throw error;
  }
}

export async function projectAutomationExecution(input: { sessionId: string; status: "succeeded" | "failed" | "cancelled"; error?: string }): Promise<void> {
  const execution = await AutomationExecutionModel.findOne({ sessionId: input.sessionId }).lean();
  if (!execution) return;
  const now = new Date();
  await AutomationExecutionModel.updateOne(
    { executionId: execution.executionId, status: { $in: ["queued", "running"] } },
    { $set: { status: input.status, ...(input.error ? { error: input.error.slice(0, 2_000) } : {}), finishedAt: now } },
  );
  await import("@/models/automation").then(({ AutomationModel }) => AutomationModel.updateOne(
    { automationId: execution.automationId, userId: execution.userId },
    { $set: { lastRunStatus: input.status === "cancelled" ? "failed" : input.status, lastError: input.error?.slice(0, 2_000) ?? null, lastRunAt: now, lastRunTaskId: execution.taskId, lastRunId: execution.runId } },
  ));
}
