import { randomUUID } from "node:crypto";

import { appendTaskEvent } from "@/lib/task-events";
import { AgentSessionModel } from "@/models/agent-session";
import { TaskRunModel, activeRunStates } from "@/models/task-run";
import { WorkspaceModel } from "@/models/workspace";

export type TaskRunView = {
  id: string;
  workspaceId: string;
  mode: "plan" | "build";
  model: string;
  prompt: string;
  baseRevisionId?: string | null;
  status: string;
  failureCode: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toTaskRunView(run: {
  runId: string;
  workspaceId: string;
  mode: "plan" | "build";
  model: string;
  prompt: string;
  baseRevisionId?: string | null;
  status: string;
  failureCode?: string | null;
  cancelRequestedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): TaskRunView {
  return {
    id: run.runId,
    workspaceId: run.workspaceId,
    mode: run.mode,
    model: run.model,
    prompt: run.prompt,
    baseRevisionId: run.baseRevisionId ?? null,
    status: run.status,
    failureCode: run.failureCode ?? null,
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function listWorkspaceTaskRuns(userId: string, workspaceId: string, limit = 30): Promise<TaskRunView[]> {
  const runs = await TaskRunModel.find({ userId, workspaceId }).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 50)).lean();
  return runs.map(toTaskRunView);
}

export async function createTaskRun(input: { runId: string; userId: string; workspaceId: string; mode: "plan" | "build"; model: string; prompt: string }): Promise<TaskRunView | null> {
  const workspace = await WorkspaceModel.findOne({ userId: input.userId, workspaceId: input.workspaceId }).lean();
  if (!workspace) return null;

  const sessionId = `session_${randomUUID()}`;
  let run;
  try {
    run = await TaskRunModel.create({
      runId: input.runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      sessionId,
      mode: input.mode,
      model: input.model,
      prompt: input.prompt,
      baseRevisionId: workspace.currentRevisionId ?? null,
      status: "queued",
      activeWorkspaceKey: input.workspaceId,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate key")) throw error;
    return null;
  }

  await AgentSessionModel.updateOne(
    { sessionId },
    {
      $setOnInsert: {
        sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        title: input.prompt.slice(0, 180) || `${input.mode} run`,
        status: "active",
      },
      $set: { currentRunId: run.runId, lastRunId: run.runId },
    },
    { upsert: true },
  );

  await appendTaskEvent({ runId: run.runId, userId: input.userId, type: "run.queued", data: { mode: input.mode, model: input.model } });
  return toTaskRunView(run);
}

export async function getTaskRun(userId: string, runId: string): Promise<TaskRunView | null> {
  const run = await TaskRunModel.findOne({ userId, runId }).lean();
  return run ? toTaskRunView(run) : null;
}

export async function cancelTaskRun(userId: string, runId: string): Promise<TaskRunView | null> {
  const run = await TaskRunModel.findOneAndUpdate(
    { userId, runId, status: { $in: activeRunStates } },
    { $set: { status: "cancelled", cancelRequestedAt: new Date(), leaseOwner: null, leaseExpiresAt: null }, $unset: { activeWorkspaceKey: 1 } },
    { new: true },
  ).lean();
  if (run) {
    await appendTaskEvent({ runId, userId, type: "run.cancelled", data: { reason: "user_request" } });
    return toTaskRunView(run);
  }
  return getTaskRun(userId, runId);
}
