import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFindOne: vi.fn(),
  taskFindOne: vi.fn(),
  workspacePolicyFindOneAndUpdate: vi.fn(),
  workspacePolicyUpdateOne: vi.fn(),
  workspaceUsageAggregate: vi.fn(),
  workspaceReconciliationFindOne: vi.fn(),
  workspaceReconciliationFindOneAndUpdate: vi.fn(),
  projectUsageAggregate: vi.fn(),
  projectReconciliationFindOne: vi.fn(),
  projectReconciliationFindOneAndUpdate: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/config/env", () => ({
  getServerEnvironment: () => ({
    RELAY_AGENT_URL: "http://relay.test",
    RELAY_AGENT_SERVICE_SECRET_CURRENT: "service-secret",
  }),
}));
vi.mock("@/models/run", () => ({ RunModel: { findOne: mocks.runFindOne } }));
vi.mock("@/models/task", () => ({ TaskModel: { findOne: mocks.taskFindOne } }));
vi.mock("@/models/project", () => ({ ProjectModel: { findOne: vi.fn() } }));
vi.mock("@/models/project-budget-policy", () => ({ ProjectBudgetPolicyModel: { findOneAndUpdate: vi.fn(), updateOne: vi.fn(), findOne: vi.fn() } }));
vi.mock("@/models/project-usage-event", () => ({ ProjectUsageEventModel: { aggregate: mocks.projectUsageAggregate } }));
vi.mock("@/models/project-relay-usage-reconciliation", () => ({ ProjectRelayUsageReconciliationModel: { findOne: mocks.projectReconciliationFindOne, findOneAndUpdate: mocks.projectReconciliationFindOneAndUpdate } }));
vi.mock("@/models/workspace-budget-policy", () => ({ WorkspaceBudgetPolicyModel: { findOneAndUpdate: mocks.workspacePolicyFindOneAndUpdate, updateOne: mocks.workspacePolicyUpdateOne, findOne: vi.fn() } }));
vi.mock("@/models/workspace-usage-event", () => ({ WorkspaceUsageEventModel: { aggregate: mocks.workspaceUsageAggregate } }));
vi.mock("@/models/workspace-relay-usage-reconciliation", () => ({ WorkspaceRelayUsageReconciliationModel: { findOne: mocks.workspaceReconciliationFindOne, findOneAndUpdate: mocks.workspaceReconciliationFindOneAndUpdate } }));

import { reconcileRunRelayUsage, reconcileWorkspaceRelayUsage } from "@/lib/project-budget";

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

function selected<T>(value: T) {
  return { select: vi.fn().mockReturnValue(lean(value)) };
}

const currentPeriod = new Date().toISOString().slice(0, 7);

describe("Workspace Relay usage reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.runFindOne.mockReturnValue(lean({ runId: "run_1", taskId: "task_1", workspaceId: "workspace_1" }));
    mocks.taskFindOne.mockReturnValue(selected({ userId: "user_1" }));
    mocks.workspaceUsageAggregate.mockResolvedValue([{ totalTokens: 25 }]);
    mocks.workspaceReconciliationFindOneAndUpdate.mockResolvedValue({});
    mocks.fetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      usageCount: 1,
      totals: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 40 },
    }), { status: 200 })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reconciles a non-Project Run once at the Workspace budget level", async () => {
    mocks.workspacePolicyFindOneAndUpdate
      .mockReturnValueOnce(lean({ workspaceId: "workspace_1", userId: "user_1", maxConcurrentRuns: 8, monthlyTokenBudget: 0, usedTokens: 10, usagePeriod: currentPeriod, reservedRuns: 0 }))
      .mockReturnValueOnce(lean({ workspaceId: "workspace_1", userId: "user_1", maxConcurrentRuns: 8, monthlyTokenBudget: 0, usedTokens: 25, usagePeriod: currentPeriod, reservedRuns: 0 }));
    mocks.workspaceReconciliationFindOne
      .mockReturnValueOnce(lean(null))
      .mockReturnValueOnce(lean({ usagePeriod: currentPeriod, appliedDeltaTokens: 15 }));

    await expect(reconcileRunRelayUsage("run_1")).resolves.toEqual({ reconciled: true, deltaTokens: 15 });
    await expect(reconcileRunRelayUsage("run_1")).resolves.toEqual({ reconciled: true, deltaTokens: 0 });

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.workspacePolicyUpdateOne).toHaveBeenCalledTimes(1);
    expect(mocks.workspacePolicyUpdateOne).toHaveBeenCalledWith(
      { workspaceId: "workspace_1", userId: "user_1" },
      { $set: { usedTokens: 25, usagePeriod: currentPeriod } },
      { upsert: true },
    );
  });

  it("keeps the immediate projection while Relay is still settling", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      usageCount: 1,
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    }), { status: 200 }));

    await expect(reconcileWorkspaceRelayUsage("run_1")).resolves.toEqual({ reconciled: false, deltaTokens: 0 });

    expect(mocks.workspacePolicyFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.workspacePolicyUpdateOne).not.toHaveBeenCalled();
    expect(mocks.workspaceReconciliationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("does not apply a completed prior-month Run to the current Workspace budget", async () => {
    const now = new Date();
    const priorMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 20));
    mocks.runFindOne.mockReturnValue(lean({ runId: "run_1", taskId: "task_1", workspaceId: "workspace_1", finishedAt: priorMonth }));

    await expect(reconcileWorkspaceRelayUsage("run_1")).resolves.toEqual({ reconciled: false, deltaTokens: 0 });

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.workspacePolicyFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
