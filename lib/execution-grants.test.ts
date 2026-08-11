import { beforeEach, describe, expect, it, vi } from "vitest";

import { consumeExecutionGrant, createExecutionGrant, getActiveExecutionGrant, revokeExecutionGrant } from "@/lib/execution-grants";

vi.mock("@/models/execution-grant", () => ({
  ExecutionGrantModel: {
    create: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateMany: vi.fn(),
  },
}));

import { ExecutionGrantModel } from "@/models/execution-grant";

const grantModel = vi.mocked(ExecutionGrantModel);

function chain(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value), sort: () => ({ lean: vi.fn().mockResolvedValue(value) }) } as never;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    grantId: "grant_1",
    runId: "run_1",
    workspaceId: "ws_1",
    userId: "user_1",
    sourceProposalId: "exec_1",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    expiresAt: new Date(Date.now() + 600_000),
    remainingCommands: 20,
    remainingWallTimeMs: 600_000,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createExecutionGrant", () => {
  it("reuses an existing active grant for the run", async () => {
    grantModel.findOne.mockReturnValue(chain(record()));
    const grant = await createExecutionGrant({ userId: "user_1", workspaceId: "ws_1", runId: "run_1", sourceProposalId: "exec_1" });
    expect(grant?.remainingCommands).toBe(20);
    expect(grantModel.create).not.toHaveBeenCalled();
  });

  it("creates a grant with default budget when none exists", async () => {
    grantModel.findOne.mockReturnValue(chain(null));
    grantModel.create.mockResolvedValue(record({}) as never);
    const grant = await createExecutionGrant({ userId: "user_1", workspaceId: "ws_1", runId: "run_1", sourceProposalId: "exec_1" });
    expect(grant).not.toBeNull();
    expect(grantModel.create).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1", remainingCommands: 20, remainingWallTimeMs: 600_000, revokedAt: null }));
  });
});

describe("getActiveExecutionGrant", () => {
  it("returns null for an expired grant", async () => {
    grantModel.findOne.mockReturnValue(chain(record({ expiresAt: new Date(Date.now() - 1000) })));
    await expect(getActiveExecutionGrant({ userId: "user_1", runId: "run_1" })).resolves.toBeNull();
  });

  it("returns null when the command budget is exhausted", async () => {
    grantModel.findOne.mockReturnValue(chain(record({ remainingCommands: 0 })));
    await expect(getActiveExecutionGrant({ userId: "user_1", runId: "run_1" })).resolves.toBeNull();
  });

  it("returns the active grant", async () => {
    grantModel.findOne.mockReturnValue(chain(record()));
    await expect(getActiveExecutionGrant({ userId: "user_1", runId: "run_1" })).resolves.toMatchObject({ id: "grant_1", remainingCommands: 20 });
  });
});

describe("consumeExecutionGrant", () => {
  it("decrements commands and wall time after a granted run", async () => {
    grantModel.findOneAndUpdate.mockReturnValue(chain(record({ remainingCommands: 19, remainingWallTimeMs: 550_000 })));
    const grant = await consumeExecutionGrant({ grantId: "grant_1", durationMs: 50_000 });
    expect(grant?.remainingCommands).toBe(19);
    expect(grantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { grantId: "grant_1", revokedAt: null, remainingCommands: { $gt: 0 } },
      { $inc: { remainingCommands: -1, remainingWallTimeMs: -50_000 } },
      { new: true },
    );
  });
});

describe("revokeExecutionGrant", () => {
  it("revokes the active grant (idempotent)", async () => {
    grantModel.updateMany.mockResolvedValue({ modifiedCount: 1 } as never);
    await revokeExecutionGrant("run_1");
    expect(grantModel.updateMany).toHaveBeenCalledWith({ runId: "run_1", revokedAt: null }, { $set: { revokedAt: expect.any(Date) } });
  });
});
