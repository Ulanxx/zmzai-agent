import { randomUUID } from "node:crypto";

import type { PersistedFrameworkEvent } from "@zmzai/agent-framework";

import { FrameworkMessageModel, FrameworkPartModel, FrameworkSessionModel } from "@/framework/core/session/mongo-models";
import { RunModel } from "@/models/run";
import { SubagentRunModel } from "@/models/subagent-run";

function id(): string {
  return `subrun_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

async function parentContext(childSessionId: string) {
  const child = await FrameworkSessionModel.findOne({ sessionId: childSessionId, parentId: { $exists: true, $ne: null } }).lean();
  if (!child?.parentId) return null;
  const parentRun = await RunModel.findOne({ sessionId: child.parentId }).sort({ createdAt: -1 }).lean();
  if (!parentRun) return null;
  return { child, parentRun };
}

async function childSummary(sessionId: string): Promise<string> {
  const messages = await FrameworkMessageModel.find({ sessionId }).lean();
  const assistant = [...messages].reverse().find((message) => (message.info as { role?: unknown }).role === "assistant");
  if (!assistant) return "";
  const parts = await FrameworkPartModel.find({ sessionId, messageId: assistant.messageId }).lean();
  return parts
    .map((part) => part.part as { type?: unknown; text?: unknown })
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
    .slice(0, 8 * 1024);
}

async function ensureSubagentRecord(input: { childSessionId: string; description?: string; prompt?: string; agent?: string }) {
  const context = await parentContext(input.childSessionId);
  if (!context) return null;
  const { child, parentRun } = context;
  const now = new Date();
  await SubagentRunModel.updateOne(
    { childSessionId: input.childSessionId },
    {
      $setOnInsert: {
        subagentRunId: id(),
        taskId: parentRun.taskId,
        parentRunId: parentRun.runId,
        parentSessionId: child.parentId,
        childSessionId: input.childSessionId,
        userId: child.userId,
        workspaceId: child.workspaceId,
        agent: input.agent ?? child.agent,
        description: input.description ?? child.title,
        prompt: input.prompt ?? child.title,
        status: "running",
        startedAt: now,
      },
      $set: {
        ...(input.description ? { description: input.description.slice(0, 240) } : {}),
        ...(input.prompt ? { prompt: input.prompt.slice(0, 8 * 1024) } : {}),
        ...(input.agent ? { agent: input.agent.slice(0, 64) } : {}),
      },
    },
    { upsert: true },
  );
  return context;
}

export async function projectSubagentEvent(event: PersistedFrameworkEvent): Promise<void> {
  if (event.type === "message.part.updated" && event.data.part.type === "subtask") {
    await ensureSubagentRecord({
      childSessionId: event.data.part.childSessionId,
      description: event.data.part.description,
      prompt: event.data.part.prompt,
      agent: event.data.part.agent,
    });
    return;
  }
  if (event.type !== "session.status" && event.type !== "session.error") return;
  const context = await ensureSubagentRecord({ childSessionId: event.sessionId });
  if (!context) return;
  if (event.type === "session.error") {
    await SubagentRunModel.updateOne({ childSessionId: event.sessionId, status: { $in: ["queued", "running"] } }, { $set: { status: "failed", error: `${event.data.name}: ${event.data.message}`.slice(0, 2_000), finishedAt: new Date() } });
    return;
  }
  if (event.data.status === "running") {
    await SubagentRunModel.updateOne({ childSessionId: event.sessionId, status: "queued" }, { $set: { status: "running", startedAt: new Date() } });
  }
  if (event.data.status === "idle") {
    const summary = await childSummary(event.sessionId).catch(() => "");
    await SubagentRunModel.updateOne(
      { childSessionId: event.sessionId, status: { $in: ["queued", "running"] } },
      { $set: { status: "completed", ...(summary ? { summary } : {}), finishedAt: new Date() } },
    );
  }
}
