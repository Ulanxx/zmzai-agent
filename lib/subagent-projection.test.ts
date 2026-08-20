import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionFindOne: vi.fn(),
  runFindOne: vi.fn(),
  subagentUpdateOne: vi.fn(),
  messageFind: vi.fn(),
  partFind: vi.fn(),
}));

vi.mock("@/framework/core/session/mongo-models", () => ({
  FrameworkSessionModel: { findOne: mocks.sessionFindOne },
  FrameworkMessageModel: { find: mocks.messageFind },
  FrameworkPartModel: { find: mocks.partFind },
}));
vi.mock("@/models/run", () => ({ RunModel: { findOne: mocks.runFindOne } }));
vi.mock("@/models/subagent-run", () => ({ SubagentRunModel: { updateOne: mocks.subagentUpdateOne } }));

import { projectSubagentEvent } from "@/lib/subagent-projection";

describe("subagent projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue({ sessionId: "ses_child", parentId: "ses_parent", userId: "user_1", workspaceId: "ws_1", agent: "explore", title: "定位入口" }) });
    mocks.runFindOne.mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ runId: "run_parent", taskId: "task_1" }) }) });
    mocks.subagentUpdateOne.mockResolvedValue({});
  });

  it("projects a child session into the parent task and marks it running", async () => {
    await projectSubagentEvent({ id: "evt_1", sessionId: "ses_child", seq: 1, at: "2026-08-20T00:00:00.000Z", type: "session.status", data: { status: "running" } });
    expect(mocks.subagentUpdateOne).toHaveBeenNthCalledWith(1,
      { childSessionId: "ses_child" },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ taskId: "task_1", parentRunId: "run_parent", parentSessionId: "ses_parent", agent: "explore", description: "定位入口", status: "running" }) }),
      { upsert: true },
    );
    expect(mocks.subagentUpdateOne).toHaveBeenNthCalledWith(2, { childSessionId: "ses_child", status: "queued" }, expect.any(Object));
  });
});
