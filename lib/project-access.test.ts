import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectFindOne: vi.fn(),
  memberFindOne: vi.fn(),
  runFindOne: vi.fn(),
  taskFindOne: vi.fn(),
}));

vi.mock("@/models/project", () => ({ ProjectModel: { findOne: mocks.projectFindOne } }));
vi.mock("@/models/project-member", () => ({ ProjectMemberModel: { findOne: mocks.memberFindOne } }));
vi.mock("@/models/run", () => ({ RunModel: { findOne: mocks.runFindOne } }));
vi.mock("@/models/task", () => ({ TaskModel: { findOne: mocks.taskFindOne } }));

import { canEditProject, canManageMembers, canReadProject, canRunProject, getProjectAccess, type ProjectRole } from "@/lib/project-access";

const roles: ProjectRole[] = ["owner", "editor", "member", "viewer"];
const memberRow = (role: string | null) => ({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(role ? { role } : null) }) });

describe("project role permission matrix", () => {
  it("grants read to every role", () => {
    for (const role of roles) expect(canReadProject(role)).toBe(true);
  });

  it("blocks run for viewer only", () => {
    expect(canRunProject("viewer")).toBe(false);
    expect(canRunProject("member")).toBe(true);
    expect(canRunProject("editor")).toBe(true);
    expect(canRunProject("owner")).toBe(true);
  });

  it("limits edit to owner and editor", () => {
    expect(canEditProject("owner")).toBe(true);
    expect(canEditProject("editor")).toBe(true);
    expect(canEditProject("member")).toBe(false);
    expect(canEditProject("viewer")).toBe(false);
  });

  it("limits member management to owner", () => {
    expect(canManageMembers("owner")).toBe(true);
    for (const role of ["editor", "member", "viewer"] as const) expect(canManageMembers(role)).toBe(false);
  });
});

describe("getProjectAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue({ projectId: "project_1", userId: "user_owner", workspaceId: "ws_1" }) });
  });

  it("resolves the creator as owner without a membership row", async () => {
    mocks.memberFindOne.mockReturnValue(memberRow(null));
    await expect(getProjectAccess("project_1", "user_owner")).resolves.toMatchObject({ role: "owner" });
    expect(mocks.memberFindOne).not.toHaveBeenCalled();
  });

  it("resolves explicit member roles", async () => {
    for (const role of ["editor", "member", "viewer"] as const) {
      mocks.memberFindOne.mockReturnValue(memberRow(role));
      await expect(getProjectAccess("project_1", "user_member")).resolves.toMatchObject({ role });
    }
  });

  it("returns null for strangers and unknown projects without distinguishing them", async () => {
    mocks.memberFindOne.mockReturnValue(memberRow(null));
    await expect(getProjectAccess("project_1", "user_stranger")).resolves.toBeNull();
    mocks.projectFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    await expect(getProjectAccess("project_missing", "user_owner")).resolves.toBeNull();
  });
});
