import { describe, expect, it } from "vitest";

import { AgentSessionModel } from "@/models/agent-session";

describe("AgentSession model", () => {
  it("keeps sessions scoped by user and workspace", () => {
    const indexes = AgentSessionModel.schema.indexes();
    expect(indexes).toContainEqual([{ userId: 1, workspaceId: 1, updatedAt: -1 }, {}]);
  });
});
