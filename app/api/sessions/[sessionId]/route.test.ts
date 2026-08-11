import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  listSessionTaskRuns: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/task-runs", () => ({ listSessionTaskRuns: mocks.listSessionTaskRuns }));

import { GET } from "@/app/api/sessions/[sessionId]/route";

function request(): Request {
  return new Request("http://localhost/api/sessions/session_1");
}

function runView(overrides: Record<string, unknown> = {}) {
  return { id: "run_1", workspaceId: "ws_1", sessionId: "session_1", mode: "build", model: "m", prompt: "p", parentRunId: null, status: "succeeded", failureCode: null, startedAt: null, finishedAt: null, createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z", ...overrides };
}

beforeEach(() => {
  mocks.getCurrentUser.mockReset();
  mocks.listSessionTaskRuns.mockReset();
});

describe("GET /api/sessions/:sessionId", () => {
  it("returns 401 without a current user", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await GET(request(), { params: Promise.resolve({ sessionId: "session_1" }) });
    expect(response.status).toBe(401);
  });

  it("returns 404 when the session has no runs (does not leak existence)", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.listSessionTaskRuns.mockResolvedValue([]);
    const response = await GET(request(), { params: Promise.resolve({ sessionId: "session_x" }) });
    expect(response.status).toBe(404);
  });

  it("returns the session runs and workspace in ascending order", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_1" });
    mocks.listSessionTaskRuns.mockResolvedValue([runView({ id: "run_1", createdAt: "2026-08-11T00:00:00.000Z" }), runView({ id: "run_2", createdAt: "2026-08-11T00:01:00.000Z" })]);
    const response = await GET(request(), { params: Promise.resolve({ sessionId: "session_1" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workspaceId).toBe("ws_1");
    expect(body.runs.map((run: { id: string }) => run.id)).toEqual(["run_1", "run_2"]);
  });
});
