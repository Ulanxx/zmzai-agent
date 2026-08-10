import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveExecutionProposal } from "@/lib/execution-proposals";

vi.mock("@/models/execution-proposal", () => ({
  ExecutionProposalModel: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
    exists: vi.fn(),
    updateOne: vi.fn(),
    find: vi.fn(),
  },
}));

vi.mock("@/models/task-run", () => ({
  TaskRunModel: { findOne: vi.fn() },
}));

import { ExecutionProposalModel } from "@/models/execution-proposal";
import { TaskRunModel } from "@/models/task-run";

const proposalModel = vi.mocked(ExecutionProposalModel);
const taskRunModel = vi.mocked(TaskRunModel);

function chain(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value), sort: () => ({ lean: vi.fn().mockResolvedValue(value) }) } as never;
}

function record(status: string) {
  return {
    proposalId: "exec_1",
    runId: "run_1",
    workspaceId: "ws_1",
    userId: "user_1",
    toolCallId: "call_1",
    program: "node",
    args: ["a.ts"],
    cwd: null,
    env: {},
    snapshotSummary: { revisionId: null, fileCount: 1, totalBytes: 13, files: ["a.ts"] },
    status,
    sandboxRunId: null,
    resultSummary: null,
    exitCode: null,
    durationMs: null,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveExecutionProposal", () => {
  it("returns null for an unknown proposal", async () => {
    proposalModel.findOne.mockReturnValue(chain(null));
    await expect(resolveExecutionProposal({ userId: "user_1", proposalId: "exec_x", action: "approve" })).resolves.toBeNull();
  });

  it("reports not_ready when the run is not waiting for approval", async () => {
    proposalModel.findOne.mockReturnValue(chain(record("pending")));
    taskRunModel.findOne.mockReturnValue(chain(null));
    const result = await resolveExecutionProposal({ userId: "user_1", proposalId: "exec_1", action: "approve" });
    expect(result?.outcome).toBe("not_ready");
  });

  it("approves only while the run is waiting_approval", async () => {
    proposalModel.findOne.mockReturnValue(chain(record("pending")));
    taskRunModel.findOne.mockReturnValue(chain({ status: "waiting_approval" }));
    proposalModel.findOneAndUpdate.mockReturnValue(chain(record("approved")));
    const result = await resolveExecutionProposal({ userId: "user_1", proposalId: "exec_1", action: "approve" });
    expect(result?.outcome).toBe("approved");
    expect(result?.proposal.status).toBe("approved");
  });

  it("rejects a pending proposal without requiring the run", async () => {
    proposalModel.findOne.mockReturnValue(chain(record("pending")));
    proposalModel.findOneAndUpdate.mockReturnValue(chain(record("rejected")));
    const result = await resolveExecutionProposal({ userId: "user_1", proposalId: "exec_1", action: "reject" });
    expect(result?.outcome).toBe("rejected");
  });

  it("surfaces the already-resolved status on repeat calls", async () => {
    proposalModel.findOne.mockReturnValue(chain(record("approved")));
    const result = await resolveExecutionProposal({ userId: "user_1", proposalId: "exec_1", action: "approve" });
    expect(result?.outcome).toBe("approved");
    expect(proposalModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
