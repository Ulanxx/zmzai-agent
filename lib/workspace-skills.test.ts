import { beforeEach, describe, expect, it, vi } from "vitest";

const skillModel = vi.hoisted(() => ({ find: vi.fn(), findOne: vi.fn(), create: vi.fn() }));
const importer = vi.hoisted(() => ({ importGithubSkill: vi.fn() }));

vi.mock("@/models/workspace-skill", () => ({ WorkspaceSkillModel: skillModel }));
vi.mock("@/lib/github-skills", () => importer);

import { addGithubWorkspaceSkill, getWorkspaceSkillsByIds, workspaceOwnsSkillIds } from "@/lib/workspace-skills";

const createdAt = new Date("2026-08-12T00:00:00.000Z");
const record = { skillId: "skl_pdf", name: "pdf", description: "PDF", repository: "openai/skills", requestedRef: "main", commitSha: "a".repeat(40), path: "skills/pdf", markdown: "# PDF", createdAt };

beforeEach(() => {
  vi.clearAllMocks();
  importer.importGithubSkill.mockResolvedValue({ repository: record.repository, requestedRef: record.requestedRef, commitSha: record.commitSha, path: record.path, name: record.name, description: record.description, markdown: record.markdown });
});

describe("workspace skill ownership", () => {
  it("returns pinned records in AgentVersion ID order", async () => {
    skillModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([record]) });
    await expect(getWorkspaceSkillsByIds({ userId: "u", workspaceId: "w", skillIds: ["skl_missing", "skl_pdf"] })).resolves.toEqual([{ skillId: "skl_pdf", name: "pdf", markdown: "# PDF" }]);
  });

  it("requires every selected Skill to be an owned, distinct record", async () => {
    skillModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([record]) });
    await expect(workspaceOwnsSkillIds({ userId: "u", workspaceId: "w", skillIds: ["skl_pdf"] })).resolves.toBe(true);
    await expect(workspaceOwnsSkillIds({ userId: "u", workspaceId: "w", skillIds: ["skl_pdf", "skl_pdf"] })).resolves.toBe(false);
  });
});

describe("addGithubWorkspaceSkill", () => {
  it("reuses the exact repository, commit, and path rather than duplicating an immutable import", async () => {
    skillModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(record) });
    const result = await addGithubWorkspaceSkill({ userId: "u", workspaceId: "w", repository: "openai/skills", path: "skills/pdf" });
    expect(result).toMatchObject({ reused: true, skill: { id: "skl_pdf", commitSha: record.commitSha } });
    expect(skillModel.create).not.toHaveBeenCalled();
  });
});
