import { randomUUID } from "node:crypto";

import type { PersistedFrameworkEvent, SessionInfo } from "@zmzai/agent-framework";

import { RunModel, type RunRecord } from "@/models/run";
import { TaskModel, type TaskRecord } from "@/models/task";
import { canSupersedeActiveRun, canTransitionRun, isActiveRunStatus, taskStatusForRun, transitionRun, type RunStatus } from "@/lib/task-state-machine";
import { releaseProjectRun, releaseWorkspaceRun, reserveProjectRun, reserveWorkspaceRun } from "@/lib/project-budget";

export class ActiveRunConflictError extends Error {
  constructor(public readonly status: RunStatus) {
    super(`任务仍有 ${status} 状态的执行实例，不能创建新的 Run`);
    this.name = "ActiveRunConflictError";
  }
}

function taskId(): string {
  return `task_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function runId(): string {
  return `run_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

export async function createTaskForSession(input: { session: SessionInfo; goal?: string; title?: string; projectId?: string | null; source?: "chat" | "automation" | "api" | "webhook" | "slack" | "email" | "research"; outputSchema?: Record<string, unknown> | null }): Promise<TaskRecord> {
  return TaskModel.create({
    taskId: taskId(),
    workspaceId: input.session.workspaceId,
    projectId: input.projectId ?? null,
    userId: input.session.userId,
    source: input.source ?? "chat",
    title: input.title ?? input.session.title,
    goal: input.goal ?? input.session.title,
    outputSchema: input.outputSchema ?? null,
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
  runIdOverride?: string;
  forceNewRun?: boolean;
  reserveBudget?: boolean;
}): Promise<RunRecord> {
  const current = await RunModel.findOne({ taskId: input.task.taskId, active: true }).sort({ createdAt: -1 }).lean();
  if (current && !input.forceNewRun) return current as RunRecord;
  if (current && input.forceNewRun) {
    const currentStatus = current.status as RunStatus;
    if (!canSupersedeActiveRun(currentStatus)) throw new ActiveRunConflictError(currentStatus);
    await RunModel.updateOne({ runId: current.runId, active: true, status: currentStatus }, { $set: { active: false } });
  }

  const previous = await RunModel.findOne({ taskId: input.task.taskId }).sort({ createdAt: -1 }).lean();
  const candidate = {
    runId: input.runIdOverride ?? runId(),
    taskId: input.task.taskId,
    workspaceId: input.session.workspaceId,
    userId: input.session.userId,
    sessionId: input.session.id,
    parentRunId: input.parentRunId ?? previous?.runId ?? null,
    resumeCheckpointId: input.resumeCheckpointId ?? null,
    status: "created" as const,
    active: true,
    budgetReserved: false,
    workspaceBudgetReserved: false,
    attempt: (previous?.attempt ?? 0) + 1,
    terminalReason: null,
    startedAt: null,
    finishedAt: null,
    latestCheckpointId: null,
  };

  if (input.reserveBudget !== false) {
    await reserveWorkspaceRun({ workspaceId: input.session.workspaceId, userId: input.task.userId });
    candidate.workspaceBudgetReserved = true;
    try {
      if (input.task.projectId) {
        await reserveProjectRun({ projectId: input.task.projectId, userId: input.task.userId });
        candidate.budgetReserved = true;
      }
    } catch (error) {
      await releaseWorkspaceRun({ workspaceId: input.session.workspaceId, userId: input.task.userId });
      candidate.workspaceBudgetReserved = false;
      throw error;
    }
  }

  let run: RunRecord;
  try {
    run = await RunModel.create(candidate);
  } catch (error) {
    if (candidate.budgetReserved && input.task.projectId) await releaseProjectRun({ projectId: input.task.projectId, userId: input.task.userId });
    if (candidate.workspaceBudgetReserved) await releaseWorkspaceRun({ workspaceId: input.session.workspaceId, userId: input.task.userId });
    if (!isDuplicateKey(error)) throw error;
    const existing = await RunModel.findOne({ taskId: input.task.taskId, active: true }).sort({ createdAt: -1 }).lean();
    if (!existing) throw error;
    const existingRun = existing as RunRecord;
    // A competing request may have won Run creation after the task projection
    // was read. Reconcile the projection on the duplicate path as well.
    await updateTaskFromRun(existingRun, existingRun.status);
    return existingRun;
  }

  // The partial unique index on RunModel is the concurrency guard. Once this
  // write succeeds, this run is the only active run for the task, so the task
  // projection can be reconciled unconditionally. Filtering on the previous
  // activeRunId here left stale task pointers behind after a restart or a
  // competing continuation had already detached the old run.
  await updateTaskFromRun(run, run.status);
  return run;
}

/** Reserve a queued Run only when its executor is about to start. This keeps
 * queued fan-out work from consuming the project's active-run budget early. */
export async function reserveRunBudget(runId: string): Promise<boolean> {
  const run = await RunModel.findOne({ runId }).lean();
  if (!run || run.budgetReserved || run.workspaceBudgetReserved) return Boolean(run?.budgetReserved || run?.workspaceBudgetReserved);
  const task = await TaskModel.findOne({ taskId: run.taskId }).select({ projectId: 1, userId: 1 }).lean();
  if (!task) return false;
  await reserveWorkspaceRun({ workspaceId: run.workspaceId, userId: task.userId });
  let projectReserved = false;
  try {
    if (task.projectId) {
      await reserveProjectRun({ projectId: task.projectId, userId: task.userId });
      projectReserved = true;
    }
    const claimed = await RunModel.updateOne({ runId, budgetReserved: false, workspaceBudgetReserved: false }, { $set: { budgetReserved: projectReserved, workspaceBudgetReserved: true } });
    if (!claimed.modifiedCount) {
      if (projectReserved && task.projectId) await releaseProjectRun({ projectId: task.projectId, userId: task.userId });
      await releaseWorkspaceRun({ workspaceId: run.workspaceId, userId: task.userId });
    }
    return claimed.modifiedCount > 0 || Boolean((await RunModel.findOne({ runId, $or: [{ budgetReserved: true }, { workspaceBudgetReserved: true }] }).lean()));
  } catch (error) {
    if (projectReserved && task.projectId) await releaseProjectRun({ projectId: task.projectId, userId: task.userId });
    await releaseWorkspaceRun({ workspaceId: run.workspaceId, userId: task.userId });
    throw error;
  }
}

export async function releaseRunBudget(runId: string): Promise<void> {
  const existing = await RunModel.findOne({ runId, $or: [{ budgetReserved: true }, { workspaceBudgetReserved: true }] }).lean();
  if (!existing) return;
  const projectWasReserved = Boolean(existing.budgetReserved);
  const workspaceWasReserved = Boolean(existing.workspaceBudgetReserved);
  const run = await RunModel.findOneAndUpdate({ runId, $or: [{ budgetReserved: true }, { workspaceBudgetReserved: true }] }, { $set: { budgetReserved: false, workspaceBudgetReserved: false } }, { new: true }).lean();
  if (!run) return;
  const task = await TaskModel.findOne({ taskId: run.taskId }).select({ projectId: 1, userId: 1 }).lean();
  if (projectWasReserved && task?.projectId) await releaseProjectRun({ projectId: task.projectId, userId: task.userId });
  if (workspaceWasReserved) await releaseWorkspaceRun({ workspaceId: run.workspaceId, userId: run.userId });
}

export async function taskForSession(sessionId: string): Promise<TaskRecord | null> {
  const run = await RunModel.findOne({ sessionId }).sort({ createdAt: -1 }).lean();
  if (!run) return null;
  return TaskModel.findOne({ taskId: run.taskId }).lean() as Promise<TaskRecord | null>;
}

export async function activeRunIdForSession(sessionId: string): Promise<string> {
  const run = await RunModel.findOne({ sessionId, active: true }).sort({ createdAt: -1 }).lean();
  return run?.runId ?? sessionId;
}

export async function ensureRunForPrompt(session: SessionInfo, goal?: string, options?: { runIdOverride?: string; parentRunId?: string | null; resumeCheckpointId?: string | null; forceNewRun?: boolean }): Promise<{ task: TaskRecord; run: RunRecord }> {
  let task = await taskForSession(session.id);
  if (!task) task = await createTaskForSession({ session, goal });
  else if (goal?.trim() && task.status === "draft") {
    const title = task.title === "新会话" ? goal.trim().slice(0, 40) : task.title;
    await TaskModel.updateOne({ taskId: task.taskId, status: "draft" }, { $set: { goal: goal.trim(), title } });
    task = (await TaskModel.findOne({ taskId: task.taskId }).lean()) as TaskRecord;
  }

  const active = await RunModel.findOne({ taskId: task.taskId, active: true }).sort({ createdAt: -1 }).lean();
  if (active && !options?.forceNewRun) return { task, run: active as RunRecord };

  const run = await createRunForTask({ task, session, ...options });
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

export async function pauseRunForSession(sessionId: string, reason = "用户暂停任务"): Promise<RunRecord | null> {
  return transitionRunForSession(sessionId, "paused", reason);
}

export async function projectFrameworkEvent(event: PersistedFrameworkEvent): Promise<void> {
  if (event.type === "session.status") {
    if (event.data.status === "running") await transitionRunForSession(event.sessionId, "running");
    if (event.data.status === "waiting_permission") await transitionRunForSession(event.sessionId, "waiting_approval");
    if (event.data.status === "waiting_input") await transitionRunForSession(event.sessionId, "waiting_input");
    // `idle` is only a legacy framework terminal signal. It is converted here
    // for B0 compatibility; P0 will replace it with an explicit terminal event.
    if (event.data.status === "idle") await transitionRunForSession(event.sessionId, "succeeded", "framework_idle");
    return;
  }
  if (event.type === "session.error") {
    await transitionRunForSession(event.sessionId, "failed", `${event.data.name}: ${event.data.message}`);
  }
}
