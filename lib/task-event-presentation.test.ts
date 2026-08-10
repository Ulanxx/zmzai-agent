import { describe, expect, it } from "vitest";

import { presentAgentEvent } from "@/lib/task-event-presentation";

describe("presentAgentEvent", () => {
  it("publishes a safe read artifact instead of raw tool output", () => {
    const events = presentAgentEvent({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", isError: false, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { path: "brief.md", content: "hello" } }) }] } } as never, new Map([["call_1", 10]]), 30);
    expect(events).toEqual([
      expect.objectContaining({ type: "tool.completed", data: expect.objectContaining({ durationMs: 20, resultSummary: expect.objectContaining({ text: expect.stringContaining("brief.md") }) }) }),
      expect.objectContaining({ type: "artifact.upsert", data: expect.objectContaining({ kind: "file_preview", title: "brief.md" }) }),
    ]);
  });

  it("redacts authentication-like tool failures", () => {
    const events = presentAgentEvent({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", isError: true, result: { content: [{ type: "text", text: "authorization: Bearer top-secret" }] } } as never, new Map(), 30);
    expect(events[0]?.data).toMatchObject({ resultSummary: expect.objectContaining({ text: expect.stringContaining("[REDACTED]") }) });
    expect(JSON.stringify(events)).not.toContain("top-secret");
  });
});
