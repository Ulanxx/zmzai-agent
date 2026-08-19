import { randomUUID } from "node:crypto";

import type { PersistedFrameworkEvent, SessionInfo } from "@zmzai/agent-framework";

import { RunModel, type RunRecord } from "@/models/run";
import { TaskModel, type TaskRecord } from "@/models/task";
import { canTransitionRun, isActiveRunStatus, taskStatusForRun, transitionRun, type RunStatus } from "@/lib/task-state-machine";

function taskId(): string {
  return `task_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function runId(): string {
  return `run_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

export async function createTaskForSession(input: { session: SessionInfo; goal?: string; title?: string }): Promise<TaskRecord> {
  return TaskModel.create({
    taskId: taskId(),
    workspaceId: input.session.workspaceId,
    userId: input.session.userId,
    title: input.title ?? input.session.title,
    goal: input.goal ?? input.session.title,
    status: "draft",
    activeRunId: null,
    latestRunId: null,
    version: 1,
  });
}

export async function createRunForTask(input: {
  task: TaskRecord;
  session: SessionInfo;
  parentRunId?: string | null;
  resumeCheckpointId?: string | null;
}): Promise<RunRecord> {
  const current = await RunModel.findOne({ taskId: input.task.taskId, active: true }).sort({ createdAt: -1 }).lean();
  if (current) return current as RunRecord;

  const previous = await RunModel.findOne({ taskId: input.task.taskId }).sort({ createdAt: -1 }).lean();
  const candidate = {
    runId: runId(),
    taskId: input.task.taskId,
    workspaceId: input.session.workspaceId,
    userId: input.session.userId,
    sessionId: input.session.id,
    parentRunId: input.parentRunId ?? previous?.runId ?? null,
    resumeCheckpointId: input.resumeCheckpointId ?? null,
    status: "created" as const,
    active: true,
    attempt: (previous?.attempt ?? 0) + 1,
    terminalReason: null,
    startedAt: null,
    finishedAt: null,
    latestCheckpointId: null,
  };

  let run: RunRecord;
  try {
    run = await RunModel.create(candidate);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await RunModel.findOne({ taskId: input.task.taskId, active: true }).sort({ createdAt: -1 }).lean();
    if (!existing) throw error;
    return existing as RunRecord;
  }

  await TaskModel.updateOne(
    { taskId: input.task.taskId, activeRunId: null },
    { $set: { status: "active", activeRunId: run.runId, latestRunId: run.runId }, $inc: { version: 1 } },
  );
  return run;
}

export async function taskForSession(sessionId: string): Promise<TaskRecord | null> {
  const run = await RunModel.findOne({ sessionId }).sort({ createdAt: -1 }).lean();
  if (!run) return null;
  return TaskModel.findOne({ taskId: run.taskId }).lean() as Promise<TaskRecord | null>;
}

export async function ensureRunForPrompt(session: SessionInfo, goal?: string): Promise<{ task: TaskRecord; run: RunRecord }> {
  let task = await taskForSession(session.id);
  if (!task) task = await createTaskForSession({ session, goal });

  const active = await RunModel.findOne({ taskId: task.taskId, active: true }).sort({ createdAt: -1 }).lean();
  if (active) return { task, run: active as RunRecord };

  const run = await createRunForTask({ task, session });
  return { task: (await TaskModel.findOne({ taskId: task.taskId }).lean()) as TaskRecord, run };
}

async function updateTaskFromRun(run: RunRecord, status: RunStatus): Promise<void> {
  const terminal = !isActiveRunStatus(status);
  await TaskModel.updateOne(
    { taskId: run.taskId },
    {
      $set: {
        status: taskStatusForRun(status),
        activeRunId: terminal ? null : run.runId,
        latestRunId: run.runId,
      },
      $inc: { version: 1 },
    },
  );
}

export async function transitionRunForSession(sessionId: string, next: RunStatus, terminalReason?: string): Promise<RunRecord | null> {
  const current = await RunModel.findOne({ sessionId, active: true }).sort({ createdAt: -1 });
  if (!current) return null;
  const from = current.status as RunStatus;
  if (from === next) return current.toObject() as RunRecord;
  if (!canTransitionRun(from, next)) return current.toObject() as RunRecord;
  transitionRun(from, next);

  const terminal = !isActiveRunStatus(next);
  const now = new Date();
  const set: Record<string, unknown> = { status: next, active: !terminal };
  if (terminal) {
    set.finishedAt = now;
    if (terminalReason) set.terminalReason = terminalReason;
  } else if (next === "running" && !current.startedAt) {
    set.startedAt = now;
  }

  const updated = await RunModel.findOneAndUpdate({ runId: current.runId, status: from, active: true }, { $set: set }, { new: true }).lean();
  if (!updated) return null;
  await updateTaskFromRun(updated as RunRecord, next);
  return updated as RunRecord;
}

export async function cancelRunForSession(sessionId: string, reason = "用户取消任务"): Promise<RunRecord | null> {
  return transitionRunForSession(sessionId, "cancelled", reason);
}

export async function projectFrameworkEvent(event: PersistedFrameworkEvent): Promise<void> {
  if (event.type === "session.status") {
    if (event.data.status === "running") await transitionRunForSession(event.sessionId, "running");
    if (event.data.status === "waiting_permission") await transitionRunForSession(event.sessionId, "waiting_approval");
    // `idle` is only a legacy framework terminal signal. It is converted here
    // for B0 compatibility; P0 will replace it with an explicit terminal event.
    if (event.data.status === "idle") await transitionRunForSession(event.sessionId, "succeeded", "framework_idle");
    return;
  }
  if (event.type === "session.error") {
    await transitionRunForSession(event.sessionId, "failed", `${event.data.name}: ${event.data.message}`);
  }
}
