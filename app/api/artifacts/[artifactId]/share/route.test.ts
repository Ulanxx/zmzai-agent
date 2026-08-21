import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getArtifactAccess: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/artifact-access", () => ({ getArtifactAccess: mocks.getArtifactAccess }));
vi.mock("@/lib/project-access", () => ({ canEditProject: vi.fn(() => true) }));
vi.mock("@/models/sandbox-artifact", () => ({ SandboxArtifactModel: { findOneAndUpdate: mocks.findOneAndUpdate } }));
vi.mock("@/config/env", () => ({ getServerEnvironment: () => ({ APP_URL: "https://agent.example.com/" }) }));

import { POST } from "@/app/api/artifacts/[artifactId]/share/route";

const params = () => Promise.resolve({ artifactId: "art_1" });

describe("POST /api/artifacts/:artifactId/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00Z"));
    mocks.currentUser.mockResolvedValue({ id: "user_owner" });
    mocks.getArtifactAccess.mockResolvedValue({ artifact: { artifactId: "art_1", userId: "user_owner" }, access: null });
    mocks.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue({ artifactId: "art_1" }) });
  });

  it("defaults to a 7-day share when no ttl is provided", async () => {
    const response = await POST(new NextRequest("http://localhost/api", { method: "POST", body: JSON.stringify({}) }), { params: params() });
    expect(response.status).toBe(200);
    const { expiresAt } = await response.json();
    expect(new Date(expiresAt).toISOString()).toBe("2026-08-28T00:00:00.000Z");
  });

  it("supports a short-lived 30-minute temporary preview for web_app artifacts", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api", { method: "POST", body: JSON.stringify({ expiresInMinutes: 30 }) }),
      { params: params() },
    );
    expect(response.status).toBe(200);
    const { expiresAt } = await response.json();
    expect(new Date(expiresAt).toISOString()).toBe("2026-08-21T00:30:00.000Z");
  });

  it("rejects providing both ttl units at once", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api", { method: "POST", body: JSON.stringify({ expiresInDays: 1, expiresInMinutes: 30 }) }),
      { params: params() },
    );
    expect(response.status).toBe(400);
  });

  it("rejects out-of-range minute values", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api", { method: "POST", body: JSON.stringify({ expiresInMinutes: 1 }) }),
      { params: params() },
    );
    expect(response.status).toBe(400);
  });
});
