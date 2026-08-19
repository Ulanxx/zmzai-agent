import { describe, expect, it } from "vitest";

import { relayAgentChatRequestSchema, sandboxArtifactMetaSchema, sandboxRunResponseSchema } from "@/lib/internal-contracts";

describe("v1 internal service contracts", () => {
  it("accepts the Relay request shape used by the Agent stream", () => {
    const parsed = relayAgentChatRequestSchema.safeParse({
      userId: "user_1",
      taskRunId: "run_1",
      requestId: "run_1_turn_1",
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "生成看板" }],
      tools: [],
      tool_choice: "none",
      stream: true,
      reasoning_effort: "medium",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts all Sandbox v1 lifecycle states", () => {
    for (const status of ["queued", "planning", "running", "waiting_approval", "cancellation_requested", "cleanup_pending", "succeeded", "failed", "cancelled"] as const) {
      const parsed = sandboxRunResponseSchema.safeParse({
        run: { id: "run_1", userId: "user_1", taskRunId: "run_1", requestId: "req_1", status, events: [], createdAt: "2026-08-20T00:00:00.000Z" },
      });
      expect(parsed.success, status).toBe(true);
    }
  });

  it("rejects a malformed Sandbox artifact hash", () => {
    const parsed = sandboxArtifactMetaSchema.safeParse({ path: "index.html", bytes: 10, contentType: "text/html", sha256: "bad", tooLarge: false });
    expect(parsed.success).toBe(false);
  });
});
