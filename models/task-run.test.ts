import { describe, expect, it } from "vitest";

import { TaskRunModel } from "@/models/task-run";

describe("task run active lock", () => {
  it("only indexes actual Workspace keys, leaving terminal runs unlocked", () => {
    const run = new TaskRunModel({
      runId: "run_test",
      workspaceId: "ws_test",
      userId: "user_test",
      sessionId: "session_test",
      mode: "plan",
      model: "gpt-5.6-luna",
      prompt: "test",
    });
    expect(run.toObject()).not.toHaveProperty("activeWorkspaceKey");

    const index = TaskRunModel.schema.indexes().find(([keys]) => "activeWorkspaceKey" in keys);
    expect(index).toEqual([
      { activeWorkspaceKey: 1 },
      { unique: true, partialFilterExpression: { activeWorkspaceKey: { $type: "string" } } },
    ]);
  });

  it("indexes the cross-workspace audit query by userId and createdAt desc", () => {
    const indexes = TaskRunModel.schema.indexes();
    expect(indexes).toContainEqual([{ userId: 1, createdAt: -1 }, {}]);
  });
});
