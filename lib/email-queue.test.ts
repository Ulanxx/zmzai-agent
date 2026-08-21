import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFindOneAndUpdate: vi.fn(),
  eventUpdateOne: vi.fn(),
  eventCreate: vi.fn(),
  eventFindOne: vi.fn(),
  automationFindOne: vi.fn(),
  launchAutomation: vi.fn(),
  launchEmailContinuation: vi.fn(),
}));

vi.mock("@/models/automation-webhook-event", () => ({ AutomationWebhookEventModel: { findOneAndUpdate: mocks.eventFindOneAndUpdate, updateOne: mocks.eventUpdateOne, create: mocks.eventCreate, findOne: mocks.eventFindOne } }));
vi.mock("@/models/automation", () => ({ AutomationModel: { findOne: mocks.automationFindOne } }));
vi.mock("@/lib/automation-execution", () => ({ launchAutomation: mocks.launchAutomation, launchEmailContinuation: mocks.launchEmailContinuation }));
vi.mock("@/lib/task-run-control", () => ({ ActiveRunConflictError: class ActiveRunConflictError extends Error { constructor(public readonly status = "running") { super(`任务仍有 ${status} 状态的执行实例`); this.name = "ActiveRunConflictError"; } } }));

import { ActiveRunConflictError } from "@/lib/task-run-control";
import { dispatchPendingEmailEvents } from "@/lib/email-queue";

function lean(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

describe("durable email queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.eventUpdateOne.mockResolvedValue({ acknowledged: true });
    mocks.automationFindOne.mockReturnValue(lean({ automationId: "auto_1", userId: "user_1", workspaceId: "ws_1", goal: "处理邮件" }));
  });

  it("dispatches a pending new-thread email and marks it launched", async () => {
    const event = { automationId: "auto_1", eventId: "email:1", executionId: "exec_1", contextText: "邮件正文", parentTaskId: null, parentSessionId: null };
    mocks.eventFindOneAndUpdate.mockReturnValueOnce(lean(event)).mockReturnValueOnce(lean(null));
    mocks.launchAutomation.mockResolvedValue({ session: { id: "ses_1" }, task: { taskId: "task_1" } });

    const result = await dispatchPendingEmailEvents({ owner: "scheduler:test", limit: 1, now: new Date("2026-08-21T00:00:00.000Z") });

    expect(result).toMatchObject({ claimed: 1, results: [{ eventId: "email:1", ok: true }] });
    expect(mocks.launchAutomation).toHaveBeenCalledWith(expect.objectContaining({ source: "email", executionId: "exec_1", contextText: "邮件正文" }));
    expect(mocks.eventUpdateOne).toHaveBeenCalledWith({ eventId: "email:1", dispatchStatus: "processing", dispatchLeaseOwner: "scheduler:test" }, expect.objectContaining({ $set: expect.objectContaining({ dispatchStatus: "launched", sessionId: "ses_1", taskId: "task_1" }) }));
  });

  it("requeues a reply while its parent Run is active", async () => {
    const event = { automationId: "auto_1", eventId: "email:2", executionId: "exec_2", contextText: "回复正文", parentTaskId: "task_1", parentSessionId: "ses_1" };
    mocks.eventFindOneAndUpdate.mockReturnValueOnce(lean(event));
    mocks.launchEmailContinuation.mockRejectedValue(new ActiveRunConflictError("running"));

    const result = await dispatchPendingEmailEvents({ owner: "scheduler:test", limit: 1, now: new Date("2026-08-21T00:00:00.000Z") });

    expect(result.results[0]).toMatchObject({ eventId: "email:2", ok: false });
    expect(mocks.eventUpdateOne).toHaveBeenCalledWith({ eventId: "email:2", dispatchStatus: "processing", dispatchLeaseOwner: "scheduler:test" }, expect.objectContaining({ $set: expect.objectContaining({ dispatchStatus: "pending", nextAttemptAt: expect.any(Date) }) }));
  });
});
