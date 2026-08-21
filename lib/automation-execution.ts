import { randomUUID } from "node:crypto";

import { defaultStore, createFrameworkSession } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { AutomationExecutionModel } from "@/models/automation-execution";
import { AutomationWebhookEventModel } from "@/models/automation-webhook-event";
import type { AutomationRecord } from "@/models/automation";
import { createRunForTask, createTaskForSession } from "@/lib/task-run-control";
import { TaskModel } from "@/models/task";
import { getWorkspace } from "@/lib/workspaces";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

async function replyToSlack(sessionId: string, status: "succeeded" | "failed"): Promise<void> {
  const execution = await AutomationExecutionModel.findOne({ sessionId, source: "slack" }).lean();
  if (!execution) return;
  const event = await AutomationWebhookEventModel.findOne({ executionId: execution.executionId }).lean();
  if (!event?.replyUrl) return;
  const { defaultStore } = await import("@/framework/core/runtime/runner");
  const { finalAssistantText } = await import("@/lib/structured-output");
  const output = finalAssistantText(await defaultStore.getMessages(sessionId));
  const text = status === "succeeded" ? output?.slice(0, 3_000) || "任务已完成，请回到 zmzai 查看结果。" : "任务执行失败，请回到 zmzai 查看详情。";
  try {
    const target = new URL(event.replyUrl);
    if (target.protocol !== "https:") return;
    const { assertPublicConnectorTarget } = await import("@/lib/workspace-connectors");
    await assertPublicConnectorTarget(target.toString());
    await fetch(target, { method: "POST", headers: { "content-type": "application/json", "user-agent": "ZMZAI-Agent-Slack/1.0" }, body: JSON.stringify({ response_type: "in_channel", text }), redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store" });
  } catch (error) {
    console.error("reply Slack command", error);
  }
}

export async function launchAutomation(input: { automation: AutomationRecord; source: "manual" | "schedule" | "webhook" | "slack" | "email"; sessionId?: string; executionId?: string; contextText?: string }) {
  const prompt = `${input.automation.goal}${input.contextText ? `\n\n${input.contextText}` : ""}`;
  const workspace = await getWorkspace(input.automation.userId, input.automation.workspaceId);
  if (!workspace) throw new Error("自动化 Workspace 不存在");
  const session = await createFrameworkSession({
    id: input.sessionId ?? id("ses"),
    store: defaultStore,
    userId: input.automation.userId,
    workspaceId: input.automation.workspaceId,
    agent: "通用",
    model: { providerId: "relay", modelId: workspace.defaultModel },
    prompt,
    title: input.automation.name,
  });
  const task = await createTaskForSession({ session, goal: input.automation.goal, title: input.automation.name, projectId: input.automation.projectId ?? null, source: input.source === "webhook" ? "webhook" : input.source === "slack" ? "slack" : input.source === "email" ? "email" : "automation" });
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
    const result = await getFrameworkRunner().prompt(session.id, { text: prompt });
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

export async function launchEmailContinuation(input: { automation: AutomationRecord; taskId: string; sourceSessionId: string; executionId: string; contextText: string }) {
  const task = await TaskModel.findOne({
    taskId: input.taskId,
    userId: input.automation.userId,
    workspaceId: input.automation.workspaceId,
  }).lean();
  if (!task) throw new Error("邮件回复对应的任务不存在");
  const workspace = await getWorkspace(input.automation.userId, input.automation.workspaceId);
  if (!workspace) throw new Error("自动化 Workspace 不存在");
  const session = await createFrameworkSession({
    id: id("ses"),
    store: defaultStore,
    userId: input.automation.userId,
    workspaceId: input.automation.workspaceId,
    parentId: input.sourceSessionId,
    agent: "通用",
    model: { providerId: "relay", modelId: workspace.defaultModel },
    prompt: input.contextText,
    title: task.title,
  });
  const previousRun = await import("@/models/run").then(({ RunModel }) => RunModel.findOne({ taskId: task.taskId }).sort({ createdAt: -1 }).lean());
  const run = await createRunForTask({ task, session, parentRunId: previousRun?.runId ?? null, forceNewRun: true });
  const execution = await AutomationExecutionModel.create({
    executionId: input.executionId,
    automationId: input.automation.automationId,
    userId: input.automation.userId,
    workspaceId: input.automation.workspaceId,
    taskId: task.taskId,
    runId: run.runId,
    sessionId: session.id,
    source: "email",
    status: "queued",
  });
  try {
    const result = await getFrameworkRunner().prompt(session.id, { text: input.contextText });
    await AutomationExecutionModel.updateOne({ executionId: execution.executionId, status: "queued" }, { $set: { status: "running", startedAt: new Date() } });
    return { session, task, run, execution: { ...execution.toObject(), status: "running" }, queued: result.queued };
  } catch (error) {
    const message = error instanceof Error ? error.message : "邮件回复启动失败";
    await AutomationExecutionModel.updateOne({ executionId: execution.executionId }, { $set: { status: "failed", error: message.slice(0, 2_000), finishedAt: new Date() } });
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
  if (input.status === "succeeded" || input.status === "failed") await replyToSlack(input.sessionId, input.status);
}
