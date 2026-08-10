import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getRunAuditDetail: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/run-audit", () => ({ getRunAuditDetail: mocks.getRunAuditDetail }));

import { GET } from "@/app/api/runs/[runId]/audit/route";

function context(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

beforeEach(() => {
  mocks.getCurrentUser.mockReset();
  mocks.getRunAuditDetail.mockReset();
});

describe("GET /api/runs/:runId/audit", () => {
  it("returns UNAUTHENTICATED without a current user", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost"), context("run_1"));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHENTICATED");
  });

  it("returns RUN_NOT_FOUND and never leaks a run the user does not own", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.getRunAuditDetail.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost"), context("run_secret"));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("RUN_NOT_FOUND");
    expect(mocks.getRunAuditDetail).toHaveBeenCalledWith("user_1", "run_secret");
  });

  it("returns the owned run detail with tool timeline and artifacts", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.getRunAuditDetail.mockResolvedValue({
      run: { id: "run_1", status: "succeeded" },
      toolCalls: [{ toolCallId: "call_1" }],
      artifacts: [{ artifactId: "artifact_1", toolCallId: "call_1" }],
    });
    const response = await GET(new Request("http://localhost"), context("run_1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run: { id: "run_1", status: "succeeded" },
      toolCalls: [{ toolCallId: "call_1" }],
      artifacts: [{ artifactId: "artifact_1", toolCallId: "call_1" }],
    });
  });
});
