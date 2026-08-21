import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  findOne: vi.fn(),
  deleteOne: vi.fn(),
  executionDeleteMany: vi.fn(),
  webhookEventDeleteMany: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/models/automation", () => ({ AutomationModel: { findOne: mocks.findOne, deleteOne: mocks.deleteOne } }));
vi.mock("@/models/automation-execution", () => ({ AutomationExecutionModel: { deleteMany: mocks.executionDeleteMany } }));
vi.mock("@/models/automation-webhook-event", () => ({ AutomationWebhookEventModel: { deleteMany: mocks.webhookEventDeleteMany } }));
vi.mock("@/lib/project-access", () => ({ canEditProject: vi.fn(() => true), getProjectAccess: vi.fn() }));
vi.mock("@/lib/automation-scheduler", () => ({ initializeAutomationSchedule: vi.fn() }));
vi.mock("@/lib/automation-schedule", () => ({ isSupportedSchedule: vi.fn(() => true), isSupportedTimeZone: vi.fn(() => true) }));

import { DELETE } from "@/app/api/automations/[automationId]/route";

describe("DELETE /api/automations/:automationId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser.mockResolvedValue({ id: "user_1" });
    mocks.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue({ automationId: "automation_1", userId: "user_1", projectId: null }) });
    mocks.deleteOne.mockResolvedValue({ deletedCount: 1 });
    mocks.executionDeleteMany.mockResolvedValue({ acknowledged: true });
    mocks.webhookEventDeleteMany.mockResolvedValue({ acknowledged: true });
  });

  it("removes execution and inbound event history with the automation", async () => {
    const response = await DELETE(new Request("http://localhost/api/automations/automation_1"), { params: Promise.resolve({ automationId: "automation_1" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(mocks.deleteOne).toHaveBeenCalledWith({ automationId: "automation_1" });
    expect(mocks.executionDeleteMany).toHaveBeenCalledWith({ automationId: "automation_1" });
    expect(mocks.webhookEventDeleteMany).toHaveBeenCalledWith({ automationId: "automation_1" });
  });
});
