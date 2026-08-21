import { describe, expect, it } from "vitest";

import { buildTaskSuggestions } from "@/lib/task-suggestions";
import type { PersistedFrameworkEvent } from "@zmzai/agent-framework";

function qaEvent(status: "passed" | "failed", failedMessages: string[] = []): PersistedFrameworkEvent {
  return {
    seq: 1,
    sessionId: "ses_1",
    type: "message.part.updated",
    at: new Date().toISOString(),
    data: {
      part: {
        type: "tool",
        tool: "qa-check",
        state: {
          status: "completed",
          metadata: { qaCheck: { status, checks: failedMessages.map((message, index) => ({ id: `c${index}`, status: "failed", message })), viewports: [] } },
        },
      },
    },
  } as unknown as PersistedFrameworkEvent;
}

describe("buildTaskSuggestions", () => {
  it("targets the concrete failed checks when qa failed", () => {
    const suggestions = buildTaskSuggestions({ task: { goal: "g", status: "failed" }, latestRun: { status: "failed", terminalReason: "QA_CHECK_FAILED" }, approvals: [], subagents: [], events: [qaEvent("failed", ["缺少响应式样式"])] });
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    expect(suggestions[0]!.prompt).toContain("缺少响应式样式");
    expect(suggestions[0]!.prompt).toContain("不要改动");
  });

  it("offers authorization-free alternatives when approval was rejected", () => {
    const suggestions = buildTaskSuggestions({ task: { goal: "g", status: "failed" }, latestRun: { status: "failed", terminalReason: "APPROVAL_REJECTED" }, approvals: [], subagents: [], events: [] });
    expect(suggestions[0]!.prompt).toContain("避开需要授权");
  });

  it("returns no suggestions while an approval is pending", () => {
    const suggestions = buildTaskSuggestions({ task: { goal: "g", status: "active" }, latestRun: { status: "waiting_approval", terminalReason: null }, approvals: [{ status: "pending" }], subagents: [], events: [] });
    expect(suggestions).toEqual([]);
  });

  it("asks for missing input specifics on waiting_input", () => {
    const suggestions = buildTaskSuggestions({ task: { goal: "g", status: "active" }, latestRun: { status: "waiting_input", terminalReason: null }, approvals: [], subagents: [], events: [] });
    expect(suggestions[0]!.prompt).toContain("逐条补充");
  });

  it("suggests improvement follow-ups after success", () => {
    const suggestions = buildTaskSuggestions({ task: { goal: "g", status: "succeeded" }, latestRun: { status: "succeeded", terminalReason: null }, approvals: [], subagents: [], events: [] });
    expect(suggestions[0]!.prompt).toContain("可改进点");
  });
});
