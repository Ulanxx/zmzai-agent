import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectFindOne: vi.fn(),
  policyFindOneAndUpdate: vi.fn(),
  policyUpdateOne: vi.fn(),
  usageCreate: vi.fn(),
  runFindOne: vi.fn(),
  taskFindOne: vi.fn(),
}));

vi.mock("@/models/project", () => ({ ProjectModel: { findOne: mocks.projectFindOne } }));
vi.mock("@/models/project-budget-policy", () => ({ ProjectBudgetPolicyModel: { findOneAndUpdate: mocks.policyFindOneAndUpdate, updateOne: mocks.policyUpdateOne, findOne: vi.fn() } }));
vi.mock("@/models/project-usage-event", () => ({ ProjectUsageEventModel: { create: mocks.usageCreate } }));
vi.mock("@/models/run", () => ({ RunModel: { findOne: mocks.runFindOne } }));
vi.mock("@/models/task", () => ({ TaskModel: { findOne: mocks.taskFindOne } }));
vi.mock("@/models/workspace-usage-event", () => ({ WorkspaceUsageEventModel: { create: vi.fn() } }));
vi.mock("@/models/workspace-budget-policy", () => ({ WorkspaceBudgetPolicyModel: { findOneAndUpdate: vi.fn(), updateOne: vi.fn() } }));

import { ProjectBudgetExceededError, recordProjectTokenUsage, reserveProjectRun } from "@/lib/project-budget";

function chain<T>(value: T) {
  return { select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }), sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }), lean: vi.fn().mockResolvedValue(value) };
}

describe("project budget", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a new Run after the monthly token budget is reached", async () => {
    mocks.projectFindOne.mockReturnValueOnce(chain({ userId: "owner_1" }));
    mocks.policyFindOneAndUpdate
      .mockReturnValueOnce(chain({ projectId: "project_1", userId: "owner_1", maxConcurrentRuns: 4, monthlyTokenBudget: 100, usedTokens: 100, usagePeriod: new Date().toISOString().slice(0, 7), reservedRuns: 0 }))
      .mockReturnValueOnce(chain(null));

    await expect(reserveProjectRun({ projectId: "project_1", userId: "member_1" })).rejects.toBeInstanceOf(ProjectBudgetExceededError);
    expect(mocks.policyFindOneAndUpdate.mock.calls[1][0]).toMatchObject({ $or: [{ monthlyTokenBudget: 0 }, { usedTokens: { $lt: 100 } }] });
  });

  it("does not increment usage when the framework event was already projected", async () => {
    mocks.runFindOne.mockReturnValueOnce(chain({ taskId: "task_1", runId: "run_1" }));
    mocks.taskFindOne.mockReturnValueOnce(chain({ projectId: "project_1", userId: "owner_1" }));
    mocks.projectFindOne.mockReturnValueOnce(chain({ userId: "owner_1" }));
    mocks.usageCreate.mockRejectedValueOnce({ code: 11000 });

    await recordProjectTokenUsage({ eventId: "evt_1", sessionId: "session_1", inputTokens: 10, outputTokens: 5 });

    expect(mocks.policyFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.policyUpdateOne).not.toHaveBeenCalled();
  });

  it("increments the current period exactly once for a new usage event", async () => {
    mocks.runFindOne.mockReturnValueOnce(chain({ taskId: "task_1", runId: "run_1" }));
    mocks.taskFindOne.mockReturnValueOnce(chain({ projectId: "project_1", userId: "owner_1" }));
    mocks.projectFindOne.mockReturnValueOnce(chain({ userId: "owner_1" }));
    mocks.usageCreate.mockResolvedValueOnce({});
    mocks.policyFindOneAndUpdate.mockReturnValueOnce(chain({ usagePeriod: new Date().toISOString().slice(0, 7) }));

    await recordProjectTokenUsage({ eventId: "evt_2", sessionId: "session_1", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });

    expect(mocks.policyUpdateOne).toHaveBeenCalledWith({ projectId: "project_1", userId: "owner_1" }, { $inc: { usedTokens: 18 } });
  });
});
