import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFindOne: vi.fn(),
  runCreate: vi.fn(),
  runUpdateOne: vi.fn(),
  taskUpdateOne: vi.fn(),
  reserveProjectRun: vi.fn(),
  releaseProjectRun: vi.fn(),
  reserveWorkspaceRun: vi.fn(),
  releaseWorkspaceRun: vi.fn(),
}));

vi.mock("@/models/run", () => ({ RunModel: { findOne: mocks.runFindOne, create: mocks.runCreate, updateOne: mocks.runUpdateOne } }));
vi.mock("@/models/task", () => ({ TaskModel: { updateOne: mocks.taskUpdateOne } }));
vi.mock("@/lib/project-budget", () => ({
  reserveProjectRun: mocks.reserveProjectRun,
  releaseProjectRun: mocks.releaseProjectRun,
  reserveWorkspaceRun: mocks.reserveWorkspaceRun,
  releaseWorkspaceRun: mocks.releaseWorkspaceRun,
}));

import { createRunForTask } from "@/lib/task-run-control";

function query(result: unknown) {
  return { sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(result) }) };
}

const task = {
  taskId: "task_1",
  workspaceId: "ws_1",
  userId: "user_1",
  title: "研究任务",
  goal: "完成研究",
  status: "draft",
  activeRunId: "run_stale",
  latestRunId: "run_stale",
  version: 3,
} as never;

const session = {
  id: "ses_1",
  workspaceId: "ws_1",
  userId: "user_1",
  title: "研究任务",
  agent: "default",
  model: { providerId: "relay", modelId: "test" },
  permission: [],
  queuedPrompts: [],
  time: { created: "2026-08-20T00:00:00.000Z", updated: "2026-08-20T00:00:00.000Z" },
} as never;

function makeRun(runId: string) {
  return {
    runId,
    taskId: "task_1",
    workspaceId: "ws_1",
    userId: "user_1",
    sessionId: "ses_1",
    parentRunId: null,
    resumeCheckpointId: null,
    status: "created",
    active: true,
    attempt: 2,
    terminalReason: null,
    startedAt: null,
    finishedAt: null,
    latestCheckpointId: null,
  };
}

describe("task/run control projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.taskUpdateOne.mockResolvedValue({ acknowledged: true });
    mocks.reserveProjectRun.mockResolvedValue(undefined);
    mocks.reserveWorkspaceRun.mockResolvedValue(undefined);
  });

  it("reconciles a stale task pointer after creating a continuation run", async () => {
    const run = makeRun("run_2");
    mocks.runFindOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ runId: "run_1", attempt: 1 }));
    mocks.runCreate.mockResolvedValue(run);

    await createRunForTask({ task, session, forceNewRun: true, parentRunId: "run_1", resumeCheckpointId: "cp_1" });

    expect(mocks.taskUpdateOne).toHaveBeenCalledWith(
      { taskId: "task_1" },
      { $set: { status: "active", activeRunId: "run_2", latestRunId: "run_2" }, $inc: { version: 1 } },
    );
  });

  it("reconciles the task projection when a concurrent create loses on the unique active-run index", async () => {
    const existing = makeRun("run_winner");
    mocks.runFindOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ runId: "run_1", attempt: 1 }))
      .mockReturnValueOnce(query(existing));
    mocks.runCreate.mockRejectedValueOnce({ code: 11000 });

    const result = await createRunForTask({ task, session, forceNewRun: true });

    expect(result).toEqual(existing);
    expect(mocks.taskUpdateOne).toHaveBeenCalledWith(
      { taskId: "task_1" },
      { $set: { status: "active", activeRunId: "run_winner", latestRunId: "run_winner" }, $inc: { version: 1 } },
    );
  });

  it("does not detach a running Run just to create a continuation", async () => {
    mocks.runFindOne.mockReturnValueOnce(query({ ...makeRun("run_live"), status: "running" }));

    await expect(createRunForTask({ task, session, forceNewRun: true })).rejects.toMatchObject({ name: "ActiveRunConflictError", status: "running" });
    expect(mocks.runUpdateOne).not.toHaveBeenCalled();
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });

  it("leaves queued fan-out Runs unreserved until their executor starts", async () => {
    const run = makeRun("run_queued");
    mocks.runFindOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(null));
    mocks.runCreate.mockResolvedValueOnce(run);

    await createRunForTask({ task: Object.assign({}, task, { projectId: "project_1" }) as never, session, reserveBudget: false });

    expect(mocks.runCreate).toHaveBeenCalledWith(expect.objectContaining({ budgetReserved: false }));
  });
});
