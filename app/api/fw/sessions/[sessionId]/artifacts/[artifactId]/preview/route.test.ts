import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getSession: vi.fn(),
  sessionProjectAccess: vi.fn(),
  findArtifactForSession: vi.fn(),
  openArtifactStream: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/framework/core/runtime/runner", () => ({ defaultStore: { getSession: mocks.getSession } }));
vi.mock("@/lib/project-access", () => ({ getSessionProjectAccess: mocks.sessionProjectAccess }));
vi.mock("@/lib/artifact-access", () => ({ findArtifactForSession: mocks.findArtifactForSession }));
vi.mock("@/lib/artifact-storage", () => ({ openArtifactStream: mocks.openArtifactStream }));

import { GET } from "@/app/api/fw/sessions/[sessionId]/artifacts/[artifactId]/preview/route";

const ctx = (sessionId: string, artifactId: string) => ({ params: Promise.resolve({ sessionId, artifactId }) });
const ownerSession = { sessionId: "session_1", userId: "user_owner" };

describe("GET session artifact preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser.mockResolvedValue({ id: "user_owner" });
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.sessionProjectAccess.mockResolvedValue(null);
  });

  it("serves a previewable artifact to the session owner", async () => {
    mocks.findArtifactForSession.mockResolvedValue({
      contentType: "text/html; charset=utf-8",
      tooLarge: false,
      gridFsFileId: "fs_1",
      sizeBytes: 10,
      sha256: "abc",
    });
    mocks.openArtifactStream.mockReturnValue(Readable.from(["<html></html>"]));

    const response = await GET(new Request("http://localhost"), ctx("session_1", "art_1"));
    expect(response.status).toBe(200);
  });

  it("returns a non-leaking 404 for a session owned by another user without project access", async () => {
    mocks.currentUser.mockResolvedValue({ id: "user_stranger" });

    const response = await GET(new Request("http://localhost"), ctx("session_1", "art_1"));
    expect(response.status).toBe(404);
    expect(mocks.findArtifactForSession).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("returns a non-leaking 404 when the artifact belongs to another session", async () => {
    mocks.findArtifactForSession.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), ctx("session_1", "art_other"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });

  it("returns 404 without a token for an unauthenticated request", async () => {
    mocks.currentUser.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), ctx("session_1", "art_1"));
    expect([401, 404]).toContain(response.status);
    expect(mocks.findArtifactForSession).not.toHaveBeenCalled();
  });
});
