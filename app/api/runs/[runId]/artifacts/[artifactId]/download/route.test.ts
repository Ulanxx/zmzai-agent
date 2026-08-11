import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getTaskRun: vi.fn(),
  openArtifactStream: vi.fn(),
  SandboxArtifactModel: { findOne: vi.fn() },
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/task-runs", () => ({ getTaskRun: mocks.getTaskRun }));
vi.mock("@/lib/artifact-storage", () => ({ openArtifactStream: mocks.openArtifactStream }));
vi.mock("@/models/sandbox-artifact", () => ({ SandboxArtifactModel: mocks.SandboxArtifactModel }));

import { GET } from "@/app/api/runs/[runId]/artifacts/[artifactId]/download/route";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/runs/run_1/artifacts/art_1/download");
}

function chain(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

function runView() {
  return { id: "run_1", workspaceId: "ws_1", sessionId: "s1", mode: "build", model: "m", prompt: "p", parentRunId: null, status: "succeeded", failureCode: null, startedAt: null, finishedAt: null, createdAt: "", updatedAt: "" };
}

function artifactDoc(overrides: Record<string, unknown> = {}) {
  return { artifactId: "art_1", runId: "run_1", userId: "user_1", toolCallId: "call_1", sandboxPath: "out/quarterly.pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sizeBytes: 1024, sha256: "abc123", gridFsFileId: { toHexString: () => "507f1f77bcf86cd799439011" }, tooLarge: false, ...overrides };
}

beforeEach(() => {
  mocks.getCurrentUser.mockReset();
  mocks.getTaskRun.mockReset();
  mocks.openArtifactStream.mockReset();
  mocks.SandboxArtifactModel.findOne.mockReset();
});

describe("GET /api/runs/:runId/artifacts/:artifactId/download", () => {
  it("returns 401 without a current user", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await GET(request(), { params: Promise.resolve({ runId: "run_1", artifactId: "art_1" }) });
    expect(response.status).toBe(401);
  });

  it("returns 404 when the run does not belong to the user", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.getTaskRun.mockResolvedValue(null);
    const response = await GET(request(), { params: Promise.resolve({ runId: "run_1", artifactId: "art_1" }) });
    expect(response.status).toBe(404);
    expect(mocks.SandboxArtifactModel.findOne).not.toHaveBeenCalled();
  });

  it("returns 404 for an artifact of another user's run", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.getTaskRun.mockResolvedValue(runView());
    mocks.SandboxArtifactModel.findOne.mockReturnValue(chain(null));
    const response = await GET(request(), { params: Promise.resolve({ runId: "run_1", artifactId: "art_x" }) });
    expect(response.status).toBe(404);
  });

  it("returns 404 for tooLarge or unbacked artifacts without leaking existence", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.getTaskRun.mockResolvedValue(runView());
    mocks.SandboxArtifactModel.findOne.mockReturnValue(chain(artifactDoc({ tooLarge: true })));
    const response = await GET(request(), { params: Promise.resolve({ runId: "run_1", artifactId: "art_1" }) });
    expect(response.status).toBe(404);
  });

  it("streams the artifact with attachment headers for an owned artifact", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.getTaskRun.mockResolvedValue(runView());
    mocks.SandboxArtifactModel.findOne.mockReturnValue(chain(artifactDoc()));
    const { Readable } = await import("node:stream");
    mocks.openArtifactStream.mockReturnValue(Readable.from([Buffer.from("pptx-bytes")]));
    const response = await GET(request(), { params: Promise.resolve({ runId: "run_1", artifactId: "art_1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("presentationml.presentation");
    expect(response.headers.get("content-disposition")).toContain("attachment; filename=\"quarterly.pptx\"");
    expect(response.headers.get("etag")).toBe("\"abc123\"");
    const body = await response.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe("pptx-bytes");
  });
});
