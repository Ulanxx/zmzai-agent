import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFindOne: vi.fn(),
  requestUpdateOne: vi.fn(),
  requestFindOne: vi.fn(),
  requestFindOneAndUpdate: vi.fn(),
  grantUpdateOne: vi.fn(),
  checkpointFindOneAndUpdate: vi.fn(),
}));

vi.mock("@/models/run", () => ({ RunModel: { findOne: mocks.runFindOne } }));
vi.mock("@/models/approval", () => ({
  ApprovalRequestModel: { updateOne: mocks.requestUpdateOne, findOne: mocks.requestFindOne, findOneAndUpdate: mocks.requestFindOneAndUpdate },
  ApprovalGrantModel: { updateOne: mocks.grantUpdateOne },
}));
vi.mock("@/models/checkpoint", () => ({ CheckpointModel: { findOneAndUpdate: mocks.checkpointFindOneAndUpdate } }));

import { projectApprovalAsked, projectApprovalReply } from "@/lib/approval-projection";

describe("approval projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runFindOne.mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ runId: "run_1", taskId: "task_1", userId: "user_1" }) }) });
    mocks.requestUpdateOne.mockResolvedValue({});
    mocks.requestFindOne.mockResolvedValue({ requestId: "per_1", taskId: "task_1", runId: "run_1", requesterId: "user_1", action: "connector", resourceScope: ["CRM/search"] });
    mocks.requestFindOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue({ requestId: "per_1", taskId: "task_1", runId: "run_1", requesterId: "user_1", action: "connector", resourceScope: ["CRM/search"], decidedBy: "user_1" }) });
    mocks.grantUpdateOne.mockResolvedValue({});
    mocks.checkpointFindOneAndUpdate.mockResolvedValue({});
  });

  it("projects a connector permission request into a task approval", async () => {
    await projectApprovalAsked({
      sessionId: "ses_1",
      request: { id: "per_1", sessionId: "ses_1", permission: "connector", patterns: ["CRM/search"], always: ["CRM/search", "CRM/*"], metadata: { connectorName: "CRM", toolName: "search" } },
    });
    expect(mocks.requestUpdateOne).toHaveBeenCalledWith(
      { requestId: "per_1" },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ taskId: "task_1", runId: "run_1", action: "connector", impact: "允许 Agent 通过 CRM 调用 search", resourceScope: ["CRM/search", "CRM/*"] }) }),
      { upsert: true },
    );
  });

  it("records one-off rejection without creating a grant", async () => {
    await projectApprovalReply({ sessionId: "ses_1", requestId: "per_1", reply: "reject", decidedBy: "user_2", feedback: "先不要访问 CRM" });
    expect(mocks.requestUpdateOne).toHaveBeenCalledWith({ requestId: "per_1", status: "pending" }, expect.objectContaining({ $set: expect.objectContaining({ status: "rejected", decidedBy: "user_2", feedback: "先不要访问 CRM" }) }));
    expect(mocks.grantUpdateOne).not.toHaveBeenCalled();
  });

  it("creates a scoped expiring grant for always approval", async () => {
    await projectApprovalReply({ sessionId: "ses_1", requestId: "per_1", reply: "always", decidedBy: "user_1" });
    expect(mocks.requestFindOneAndUpdate).toHaveBeenCalledWith(
      { requestId: "per_1", status: "pending", grantId: null },
      expect.objectContaining({ $set: expect.objectContaining({ status: "approved", grantId: expect.stringMatching(/^apg_/) }) }),
      { new: true },
    );
    expect(mocks.grantUpdateOne).toHaveBeenCalledWith(expect.objectContaining({ grantId: expect.stringMatching(/^apg_/) }), expect.objectContaining({ $setOnInsert: expect.objectContaining({ taskId: "task_1", action: "connector", resourceScope: ["CRM/search"], allowContinuation: true }) }), { upsert: true });
    expect(mocks.checkpointFindOneAndUpdate).toHaveBeenCalled();
  });
});
