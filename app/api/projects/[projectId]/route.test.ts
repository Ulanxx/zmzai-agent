import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  access: vi.fn(),
  projectDeleteOne: vi.fn(),
  automationFind: vi.fn(),
  taskUpdateMany: vi.fn(),
  contextDeleteMany: vi.fn(),
  memberDeleteMany: vi.fn(),
  artifactDeleteMany: vi.fn(),
  automationDeleteMany: vi.fn(),
  executionDeleteMany: vi.fn(),
  webhookEventDeleteMany: vi.fn(),
  researchUpdateMany: vi.fn(),
  budgetDeleteMany: vi.fn(),
  usageDeleteMany: vi.fn(),
  reconciliationDeleteMany: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/project-access", () => ({ canEditProject: vi.fn(() => true), getProjectAccess: mocks.access }));
vi.mock("@/models/project", () => ({ ProjectModel: { deleteOne: mocks.projectDeleteOne } }));
vi.mock("@/models/task", () => ({ TaskModel: { updateMany: mocks.taskUpdateMany } }));
vi.mock("@/models/project-context-item", () => ({ ProjectContextItemModel: { deleteMany: mocks.contextDeleteMany } }));
vi.mock("@/models/project-member", () => ({ ProjectMemberModel: { deleteMany: mocks.memberDeleteMany } }));
vi.mock("@/models/project-artifact", () => ({ ProjectArtifactModel: { deleteMany: mocks.artifactDeleteMany } }));
vi.mock("@/models/automation", () => ({ AutomationModel: { find: mocks.automationFind, deleteMany: mocks.automationDeleteMany } }));
vi.mock("@/models/automation-execution", () => ({ AutomationExecutionModel: { deleteMany: mocks.executionDeleteMany } }));
vi.mock("@/models/automation-webhook-event", () => ({ AutomationWebhookEventModel: { deleteMany: mocks.webhookEventDeleteMany } }));
vi.mock("@/models/wide-research-job", () => ({ WideResearchJobModel: { updateMany: mocks.researchUpdateMany } }));
vi.mock("@/models/project-budget-policy", () => ({ ProjectBudgetPolicyModel: { deleteMany: mocks.budgetDeleteMany } }));
vi.mock("@/models/project-usage-event", () => ({ ProjectUsageEventModel: { deleteMany: mocks.usageDeleteMany } }));
vi.mock("@/models/project-relay-usage-reconciliation", () => ({ ProjectRelayUsageReconciliationModel: { deleteMany: mocks.reconciliationDeleteMany } }));

import { DELETE } from "@/app/api/projects/[projectId]/route";

describe("DELETE /api/projects/:projectId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser.mockResolvedValue({ id: "user_1" });
    mocks.access.mockResolvedValue({
      role: "owner",
      project: { projectId: "project_1", userId: "user_1", workspaceId: "workspace_1" },
    });
    mocks.projectDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mocks.automationFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ automationId: "automation_1" }]),
      }),
    });
    for (const mock of [
      mocks.taskUpdateMany,
      mocks.contextDeleteMany,
      mocks.memberDeleteMany,
      mocks.artifactDeleteMany,
      mocks.automationDeleteMany,
      mocks.executionDeleteMany,
      mocks.webhookEventDeleteMany,
      mocks.researchUpdateMany,
      mocks.budgetDeleteMany,
      mocks.usageDeleteMany,
      mocks.reconciliationDeleteMany,
    ]) mock.mockResolvedValue({ acknowledged: true });
  });

  it("detaches tasks and research while removing project-owned records", async () => {
    const response = await DELETE(new Request("http://localhost/api/projects/project_1"), { params: Promise.resolve({ projectId: "project_1" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(mocks.projectDeleteOne).toHaveBeenCalledWith({ projectId: "project_1", userId: "user_1" });
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({ projectId: "project_1" }, { $set: { projectId: null } });
    expect(mocks.researchUpdateMany).toHaveBeenCalledWith({ projectId: "project_1" }, { $set: { projectId: null } });
    expect(mocks.executionDeleteMany).toHaveBeenCalledWith({ automationId: { $in: ["automation_1"] } });
    expect(mocks.webhookEventDeleteMany).toHaveBeenCalledWith({ automationId: { $in: ["automation_1"] } });
    expect(mocks.contextDeleteMany).toHaveBeenCalledWith({ projectId: "project_1" });
    expect(mocks.memberDeleteMany).toHaveBeenCalledWith({ projectId: "project_1" });
    expect(mocks.artifactDeleteMany).toHaveBeenCalledWith({ projectId: "project_1" });
    expect(mocks.budgetDeleteMany).toHaveBeenCalledWith({ projectId: "project_1" });
    expect(mocks.usageDeleteMany).toHaveBeenCalledWith({ projectId: "project_1" });
    expect(mocks.reconciliationDeleteMany).toHaveBeenCalledWith({ projectId: "project_1" });
  });

  it("does not delete a project for a non-owner", async () => {
    mocks.access.mockResolvedValue({ role: "editor", project: { projectId: "project_1" } });

    const response = await DELETE(new Request("http://localhost/api/projects/project_1"), { params: Promise.resolve({ projectId: "project_1" }) });

    expect(response.status).toBe(403);
    expect(mocks.projectDeleteOne).not.toHaveBeenCalled();
  });
});
