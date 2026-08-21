import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({ findOne: vi.fn() }));
const runs = vi.hoisted(() => ({ findOne: vi.fn() }));
const tasks = vi.hoisted(() => ({ findOne: vi.fn() }));
const references = vi.hoisted(() => ({ find: vi.fn() }));
const projectAccess = vi.hoisted(() => ({ getProjectAccess: vi.fn() }));

vi.mock("@/models/sandbox-artifact", () => ({ SandboxArtifactModel: sandbox }));
vi.mock("@/models/run", () => ({ RunModel: runs }));
vi.mock("@/models/task", () => ({ TaskModel: tasks }));
vi.mock("@/models/project-artifact", () => ({ ProjectArtifactModel: references }));
vi.mock("@/lib/project-access", () => projectAccess);

import { getArtifactAccess } from "@/lib/artifact-access";

const artifact = { artifactId: "art_1", runId: "run_1", userId: "owner", sizeBytes: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  sandbox.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(artifact) });
  runs.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  tasks.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  references.find.mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }) });
  projectAccess.getProjectAccess.mockResolvedValue(null);
});

describe("artifact access", () => {
  it("does not expose an unrelated personal artifact", async () => {
    await expect(getArtifactAccess("art_1", "stranger")).resolves.toBeNull();
  });

  it("allows a project member to read an explicitly referenced artifact", async () => {
    references.find.mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([{ projectId: "project_1" }]) }) });
    projectAccess.getProjectAccess.mockResolvedValue({ project: { projectId: "project_1" }, role: "viewer" });
    await expect(getArtifactAccess("art_1", "member")).resolves.toMatchObject({ artifact, access: { role: "viewer" } });
  });
});
