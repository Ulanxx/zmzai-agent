import { beforeEach, describe, expect, it, vi } from "vitest";

import { recoverExpiredLeases } from "@/lib/lease-recovery";

vi.mock("@/lib/agent-runtime", () => ({
  isAgentAlive: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/database/mongodb", () => ({
  connectMongo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/task-events", () => ({
  appendTaskEvent: vi.fn(),
}));

vi.mock("@/lib/execution-resume", () => ({
  abortActiveExecution: vi.fn(),
}));

vi.mock("@/lib/sandbox-client", () => ({
  cancelAgentSandboxRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/models/execution-proposal", () => ({
  ExecutionProposalModel: { find: vi.fn() },
}));

vi.mock("@/models/task-run", () => ({
  TaskRunModel: { find: vi.fn(), updateOne: vi.fn() },
}));

import { isAgentAlive } from "@/lib/agent-runtime";
import { cancelAgentSandboxRun } from "@/lib/sandbox-client";
import { appendTaskEvent } from "@/lib/task-events";
import { ExecutionProposalModel } from "@/models/execution-proposal";
import { TaskRunModel } from "@/models/task-run";

const taskRunModel = vi.mocked(TaskRunModel);
const executionProposalModel = vi.mocked(ExecutionProposalModel);
const isAgentAliveMock = vi.mocked(isAgentAlive);
const appendTaskEventMock = vi.mocked(appendTaskEvent);
const cancelAgentSandboxRunMock = vi.mocked(cancelAgentSandboxRun);

function chain(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value), select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }) } as never;
}

function runRecord(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run_1",
    userId: "user_1",
    workspaceId: "ws_1",
    status: "running",
    leaseOwner: "node:1",
    leaseExpiresAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAgentAliveMock.mockReturnValue(false);
  cancelAgentSandboxRunMock.mockResolvedValue(undefined);
});

describe("recoverExpiredLeases", () => {
  it("fails an orphaned run with an expired lease and releases the workspace lock", async () => {
    taskRunModel.find.mockReturnValueOnce(chain([runRecord()])).mockReturnValueOnce(chain([]));
    taskRunModel.updateOne.mockResolvedValue({ modifiedCount: 1 } as never);
    executionProposalModel.find.mockReturnValue(chain([]));

    const result = await recoverExpiredLeases(Date.now());

    expect(result.recovered).toBe(1);
    expect(taskRunModel.updateOne).toHaveBeenCalledWith(
      { runId: "run_1", status: { $in: ["queued", "running"] } },
      expect.objectContaining({ $set: expect.objectContaining({ status: "failed", failureCode: "LEASE_EXPIRED" }), $unset: { activeWorkspaceKey: 1 } }),
    );
    expect(appendTaskEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: "run.failed", data: expect.objectContaining({ code: "LEASE_EXPIRED" }) }));
  });

  it("skips runs whose Agent is still alive in this process", async () => {
    taskRunModel.find.mockReturnValueOnce(chain([runRecord()])).mockReturnValueOnce(chain([]));
    isAgentAliveMock.mockReturnValue(true);

    const result = await recoverExpiredLeases(Date.now());

    expect(result.recovered).toBe(0);
    expect(taskRunModel.updateOne).not.toHaveBeenCalled();
  });

  it("cascade-cancels in-flight sandbox runs of a recovered run", async () => {
    taskRunModel.find.mockReturnValueOnce(chain([runRecord()])).mockReturnValueOnce(chain([]));
    taskRunModel.updateOne.mockResolvedValue({ modifiedCount: 1 } as never);
    executionProposalModel.find.mockReturnValue(chain([{ sandboxRunId: "sandbox_9" }]));

    await recoverExpiredLeases(Date.now());

    expect(cancelAgentSandboxRunMock).toHaveBeenCalledWith("sandbox_9");
  });

  it("reclaims an orphaned waiting_approval run after the grace period", async () => {
    taskRunModel.find.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([runRecord({ status: "waiting_approval", leaseOwner: null, leaseExpiresAt: null })]));
    taskRunModel.updateOne.mockResolvedValue({ modifiedCount: 1 } as never);
    executionProposalModel.find.mockReturnValue(chain([]));

    const result = await recoverExpiredLeases(Date.now());

    expect(result.recovered).toBe(1);
    expect(taskRunModel.updateOne).toHaveBeenCalledWith({ runId: "run_1", status: "waiting_approval" }, expect.objectContaining({ $unset: { activeWorkspaceKey: 1 } }));
  });
});
