import { describe, expect, it } from "vitest";

import { checkpointSummary } from "@/lib/task-checkpoint";
import type { PersistedFrameworkEvent } from "@zmzai/agent-framework";

function event(input: PersistedFrameworkEvent): PersistedFrameworkEvent {
  return input;
}

describe("task checkpoint summaries", () => {
  it("records a tool boundary without persisting its input or output", () => {
    const summary = checkpointSummary(event({
      id: "evt_1",
      sessionId: "ses_1",
      seq: 8,
      at: "2026-08-20T00:00:00.000Z",
      type: "message.part.updated",
      data: {
        part: {
          id: "part_1",
          sessionId: "ses_1",
          messageId: "msg_1",
          type: "tool",
          callId: "call_1",
          tool: "bash",
          state: {
            status: "completed",
            input: { token: "should-not-persist" },
            output: "private command output",
            title: "生成网页",
            time: { start: "2026-08-20T00:00:00.000Z", end: "2026-08-20T00:00:01.000Z" },
          },
        },
      },
    }));

    expect(summary).toMatchObject({ boundary: "tool", summary: { callId: "call_1", tool: "bash", status: "completed", title: "生成网页" } });
    expect(JSON.stringify(summary)).not.toContain("should-not-persist");
    expect(JSON.stringify(summary)).not.toContain("private command output");
  });

  it("summarizes todo progress as a step checkpoint", () => {
    const summary = checkpointSummary(event({
      id: "evt_2",
      sessionId: "ses_1",
      seq: 9,
      at: "2026-08-20T00:00:02.000Z",
      type: "todo.updated",
      data: { todos: [{ content: "生成页面", status: "completed" }, { content: "检查移动端", status: "in_progress" }] },
    }));

    expect(summary).toMatchObject({ boundary: "step", summary: { total: 2, completed: 1, inProgress: 1 } });
  });

  it("ignores transcript-only events", () => {
    const summary = checkpointSummary(event({
      id: "evt_3",
      sessionId: "ses_1",
      seq: 10,
      at: "2026-08-20T00:00:03.000Z",
      type: "message.part.delta",
      data: { messageId: "msg_1", partId: "part_2", field: "text", delta: "hello" },
    }));

    expect(summary).toBeNull();
  });
});
