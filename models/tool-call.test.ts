import { describe, expect, it } from "vitest";

import { ToolCallModel } from "@/models/tool-call";

describe("ToolCall model", () => {
  it("tracks tool calls by run and status", () => {
    const indexes = ToolCallModel.schema.indexes();
    expect(indexes).toContainEqual([{ runId: 1, toolCallId: 1 }, { unique: true }]);
    expect(indexes).toContainEqual([{ runId: 1, status: 1 }, {}]);
  });
});
