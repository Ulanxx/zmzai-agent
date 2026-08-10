import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  parseAuditListParams: vi.fn(),
  listRunAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/run-audit", () => ({
  parseAuditListParams: mocks.parseAuditListParams,
  listRunAudit: mocks.listRunAudit,
}));

import { GET } from "@/app/api/audit/runs/route";

const auditParams = { range: "7d", workspaceId: null, status: null, cursor: null, limit: 30 } as const;

function request(url = "http://localhost/api/audit/runs?range=7d"): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  mocks.getCurrentUser.mockReset();
  mocks.parseAuditListParams.mockReset();
  mocks.listRunAudit.mockReset();
});

describe("GET /api/audit/runs", () => {
  it("returns UNAUTHENTICATED without a current user", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "UNAUTHENTICATED", error: "请先登录" });
  });

  it("returns INVALID_QUERY for illegal filter parameters", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.parseAuditListParams.mockReturnValue({ ok: false });
    const response = await GET(request("http://localhost/api/audit/runs?range=1y"));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_QUERY");
    expect(mocks.listRunAudit).not.toHaveBeenCalled();
  });

  it("returns WORKSPACE_NOT_FOUND when the workspace filter is not owned", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.parseAuditListParams.mockReturnValue({ ok: true, value: { ...auditParams, workspaceId: "ws_9" } });
    mocks.listRunAudit.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("returns the audited runs and next cursor scoped to the current user", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.parseAuditListParams.mockReturnValue({ ok: true, value: { ...auditParams, status: "failed" } });
    mocks.listRunAudit.mockResolvedValue({ runs: [{ id: "run_1" }], nextCursor: null });
    const response = await GET(request("http://localhost/api/audit/runs?range=7d&status=failed"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runs: [{ id: "run_1" }], nextCursor: null });
    expect(mocks.listRunAudit).toHaveBeenCalledWith({ userId: "user_1", params: { ...auditParams, status: "failed" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
