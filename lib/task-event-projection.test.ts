import { describe, expect, it } from "vitest";

import { projectTaskEvents } from "@/lib/task-event-projection";

describe("projectTaskEvents", () => {
  it("builds one tool node, one streaming message, and its canvas artifact", () => {
    const projection = projectTaskEvents([
      { id: "evt_3", sequence: 3, type: "tool.completed", at: "", data: { toolCallId: "call_1", name: "read", durationMs: 24, resultSummary: { text: "已读取 brief.md", truncated: false, omittedBytes: 0 } } },
      { id: "evt_1", sequence: 1, type: "message.started", at: "", data: { messageId: "msg_1" } },
      { id: "evt_2", sequence: 2, type: "tool.requested", at: "", data: { toolCallId: "call_1", name: "read", argsSummary: "read brief.md" } },
      { id: "evt_4", sequence: 4, type: "artifact.upsert", at: "", data: { artifactId: "artifact_1", toolCallId: "call_1", kind: "file_preview", title: "brief.md", payload: { content: "hello" } } },
      { id: "evt_5", sequence: 5, type: "message.delta", at: "", data: { messageId: "msg_1", delta: "完成" } },
      { id: "evt_6", sequence: 6, type: "message.completed", at: "", data: { messageId: "msg_1" } },
    ]);
    expect(projection.tools).toEqual([expect.objectContaining({ id: "call_1", status: "completed", durationMs: 24 })]);
    expect(projection.messages).toEqual([{ id: "msg_1", text: "完成", completed: true }]);
    expect(projection.artifacts).toEqual([expect.objectContaining({ id: "artifact_1", kind: "file_preview" })]);
    expect(projection.transcript).toEqual([{ kind: "message", id: "msg_1" }, { kind: "tool", id: "call_1" }]);
  });

  it("preserves a truncated append marker for canvas recovery", () => {
    const projection = projectTaskEvents([
      { id: "evt_1", sequence: 1, type: "artifact.upsert", at: "", data: { artifactId: "artifact_1", kind: "execution_output", title: "终端", payload: { content: "a" } } },
      { id: "evt_2", sequence: 2, type: "artifact.append", at: "", data: { artifactId: "artifact_1", text: "b", truncated: true, omittedBytes: 12 } },
    ]);
    expect(projection.artifacts[0]?.payload).toMatchObject({ content: "ab", truncated: true, omittedBytes: 12 });
  });
});
