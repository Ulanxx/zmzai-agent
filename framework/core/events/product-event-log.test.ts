import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  read: vi.fn(),
  count: vi.fn(),
  projectFrameworkEvent: vi.fn(),
  projectApprovalEvent: vi.fn(),
  projectSubagentEvent: vi.fn(),
  persistTaskCheckpoint: vi.fn(),
  qualityGateFailureReason: vi.fn(),
  runFindOne: vi.fn(),
  projectAutomationExecution: vi.fn(),
  releaseRunBudget: vi.fn(),
  enqueueTaskWebhookEvent: vi.fn(),
  dispatchDueWebhookDeliveries: vi.fn(),
  reconcileRunRelayUsage: vi.fn(),
}));

vi.mock("@/framework/core/events/mongo-event-log", () => ({
  mongoEventLog: { append: mocks.append, read: mocks.read, count: mocks.count },
}));
vi.mock("@/lib/task-run-control", () => ({ projectFrameworkEvent: mocks.projectFrameworkEvent, transitionRunForSession: vi.fn(), releaseRunBudget: mocks.releaseRunBudget }));
vi.mock("@/lib/task-checkpoint", () => ({ persistTaskCheckpoint: mocks.persistTaskCheckpoint }));
vi.mock("@/lib/approval-projection", () => ({ projectApprovalEvent: mocks.projectApprovalEvent }));
vi.mock("@/lib/subagent-projection", () => ({ projectSubagentEvent: mocks.projectSubagentEvent }));
vi.mock("@/lib/task-quality-gate", () => ({ qualityGateFailureReason: mocks.qualityGateFailureReason }));
vi.mock("@/models/run", () => ({ RunModel: { findOne: mocks.runFindOne } }));
vi.mock("@/lib/automation-execution", () => ({ projectAutomationExecution: mocks.projectAutomationExecution }));
vi.mock("@/lib/outbound-webhooks", () => ({ enqueueTaskWebhookEvent: mocks.enqueueTaskWebhookEvent, dispatchDueWebhookDeliveries: mocks.dispatchDueWebhookDeliveries }));
vi.mock("@/lib/project-budget", () => ({ reconcileRunRelayUsage: mocks.reconcileRunRelayUsage }));

import { productEventLog } from "@/framework/core/events/product-event-log";

describe("productEventLog recovery projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let seq = 0;
    mocks.append.mockImplementation(async (event: { sessionId: string; type: string; data: unknown }) => ({
      id: `evt_${++seq}`,
      seq,
      at: "2026-08-20T00:00:00.000Z",
      ...event,
    }));
    mocks.read.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    mocks.projectFrameworkEvent.mockResolvedValue(undefined);
    mocks.projectApprovalEvent.mockResolvedValue(undefined);
    mocks.projectSubagentEvent.mockResolvedValue(undefined);
    mocks.persistTaskCheckpoint.mockResolvedValue(undefined);
    mocks.qualityGateFailureReason.mockReturnValue(null);
    mocks.projectAutomationExecution.mockResolvedValue(undefined);
    mocks.releaseRunBudget.mockResolvedValue(undefined);
    mocks.enqueueTaskWebhookEvent.mockResolvedValue(0);
    mocks.dispatchDueWebhookDeliveries.mockResolvedValue({ claimed: 0, delivered: 0, failed: 0 });
    mocks.reconcileRunRelayUsage.mockResolvedValue({ reconciled: false, deltaTokens: 0 });
    mocks.runFindOne.mockReturnValue({ sort: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ runId: "run_expired", status: "failed" }) }) }) });
  });

  it("projects lease recovery failure before its legacy idle settle event", async () => {
    await productEventLog.append({
      sessionId: "ses_expired",
      type: "session.error",
      data: { name: "LeaseExpired", message: "运行因服务重启中断" },
    });
    await productEventLog.append({
      sessionId: "ses_expired",
      type: "session.status",
      data: { status: "idle" },
    });

    expect(mocks.projectFrameworkEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: "ses_expired",
      type: "session.error",
      data: expect.objectContaining({ name: "LeaseExpired" }),
    }));
    expect(mocks.projectFrameworkEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: "ses_expired",
      type: "session.status",
      data: { status: "idle" },
    }));
    expect(mocks.releaseRunBudget).toHaveBeenCalledWith("run_expired");
    expect(mocks.enqueueTaskWebhookEvent).toHaveBeenCalledWith({ sessionId: "ses_expired", eventType: "task.failed" });
    expect(mocks.reconcileRunRelayUsage).toHaveBeenCalledWith("run_expired");
  });
});
