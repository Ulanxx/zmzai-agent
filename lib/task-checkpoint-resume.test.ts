import { describe, expect, it } from "vitest";

import { buildCheckpointResumeContext, type CheckpointResumeSummary } from "@/lib/task-checkpoint";

describe("checkpoint resume contract", () => {
  it("uses counts and identifiers without exposing tool input or output", async () => {
    const checkpoint: CheckpointResumeSummary & { secret: string } = {
      checkpointId: "chk_1",
      eventSeq: 12,
      boundary: "tool",
      summary: { status: "running", tool: "bash" },
      completedStepIds: ["todo:0"],
      completedToolCallIds: ["call_1"],
      artifactIds: ["art_1"],
      secret: "must-not-be-injected",
    };
    const prompt = buildCheckpointResumeContext(checkpoint);
    expect(prompt).toContain("chk_1");
    expect(prompt).toContain("已完成工具调用 1 个");
    expect(prompt).not.toContain("must-not-be-injected");
  });
});
