import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExecTools } from "@/lib/exec-tool-broker";

vi.mock("@/lib/execution-proposals", () => ({
  createPendingExecution: vi.fn(),
}));

vi.mock("@/lib/execution-grants", () => ({
  getActiveExecutionGrant: vi.fn().mockResolvedValue(null),
  consumeExecutionGrant: vi.fn().mockResolvedValue({ id: "grant_1", remainingCommands: 19, remainingWallTimeMs: 1, revokedAt: null }),
}));

vi.mock("@/lib/sandbox-execution", () => ({
  runSandboxCommandAndStream: vi.fn(),
}));

vi.mock("@/lib/sandbox-snapshot", () => ({
  buildExecSnapshot: vi.fn(),
  SnapshotError: class SnapshotError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "SnapshotError";
    }
  },
}));

import { createPendingExecution } from "@/lib/execution-proposals";
import { getActiveExecutionGrant } from "@/lib/execution-grants";
import { runSandboxCommandAndStream } from "@/lib/sandbox-execution";
import { buildExecSnapshot, SnapshotError } from "@/lib/sandbox-snapshot";

const createPendingExecutionMock = vi.mocked(createPendingExecution);
const buildExecSnapshotMock = vi.mocked(buildExecSnapshot);
const getActiveExecutionGrantMock = vi.mocked(getActiveExecutionGrant);
const runSandboxCommandAndStreamMock = vi.mocked(runSandboxCommandAndStream);

function toolInput() {
  return { userId: "user_1", workspaceId: "ws_1", runId: "run_1" };
}

function snapshotResult() {
  return { snapshot: { revisionId: null, files: [{ path: "src/app.ts", content: "export {};" }] }, summary: { revisionId: null, fileCount: 1, totalBytes: 13, files: ["src/app.ts"] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  buildExecSnapshotMock.mockResolvedValue(snapshotResult());
});

describe("exec tool broker", () => {
  it("rejects programs outside the allowlist", async () => {
    const [tool] = createExecTools(toolInput());
    await expect(tool.execute("call_1", { program: "sudo", args: ["rm", "-rf", "/"] })).rejects.toThrow("不在允许列表");
    expect(createPendingExecutionMock).not.toHaveBeenCalled();
  });

  it("stages a pending execution with the snapshot summary and terminates the turn", async () => {
    createPendingExecutionMock.mockResolvedValue({ id: "exec_1", runId: "run_1", workspaceId: "ws_1", kind: "exec", toolCallId: "call_1", program: "node", args: ["src/app.ts"], cwd: null, env: {}, snapshotSummary: snapshotResult().summary, status: "pending", sandboxRunId: null, resultSummary: null, exitCode: null, durationMs: null, createdAt: "", updatedAt: "" });
    const [tool] = createExecTools(toolInput());
    const result = await tool.execute("call_1", { program: "node", args: ["src/app.ts"] });

    expect(result.terminate).toBe(true);
    expect(result.details.pendingApproval).toBe(true);
    expect(result.details.proposalId).toBe("exec_1");
    expect(createPendingExecutionMock).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "call_1", program: "node", args: ["src/app.ts"], snapshotSummary: { revisionId: null, fileCount: 1, totalBytes: 13, files: ["src/app.ts"] } }));
  });

  it("fails when an execution proposal is already pending", async () => {
    createPendingExecutionMock.mockRejectedValue(new Error("EXEC_ALREADY_PENDING"));
    const [tool] = createExecTools(toolInput());
    await expect(tool.execute("call_1", { program: "node", args: ["a.ts"] })).rejects.toThrow("已有待审批");
  });

  it("fails cleanly when the shadow snapshot is too large", async () => {
    buildExecSnapshotMock.mockRejectedValue(new SnapshotError("SNAPSHOT_TOO_LARGE", "快照文件数超过 200 限制，无法在沙箱中执行"));
    const [tool] = createExecTools(toolInput());
    await expect(tool.execute("call_1", { program: "node", args: ["a.ts"] })).rejects.toThrow("超过 200");
  });
});

describe("exec tool broker with task grant", () => {
  beforeEach(() => {
    getActiveExecutionGrantMock.mockResolvedValue({ id: "grant_1", runId: "run_1", workspaceId: "ws_1", sourceProposalId: "exec_0", createdAt: "", expiresAt: "2099-01-01T00:00:00.000Z", remainingCommands: 10, remainingWallTimeMs: 600000, revokedAt: null });
    runSandboxCommandAndStreamMock.mockResolvedValue({ ok: true, exitCode: 0, outputText: "ok", durationMs: 100, sandboxRunId: "sandbox_1", errorMessage: null, artifacts: [{ path: "out.pptx", bytes: 2048, contentType: "application/octet-stream", sha256: "abc", tooLarge: false }] });
    buildExecSnapshotMock.mockResolvedValue(snapshotResult());
  });

  it("runs directly without staging a proposal when a grant is active", async () => {
    const [tool] = createExecTools(toolInput());
    const result = await tool.execute("call_granted", { program: "node", args: ["gen.js"] });

    expect(result.terminate).toBeUndefined();
    expect(result.details.granted).toBe(true);
    expect(result.details.exitCode).toBe(0);
    expect(createPendingExecutionMock).not.toHaveBeenCalled();
    expect(runSandboxCommandAndStreamMock).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "call_granted", command: expect.objectContaining({ program: "node", args: ["gen.js"] }) }));
  });

  it("reports deliverables in the granted result so the model can iterate", async () => {
    const [tool] = createExecTools(toolInput());
    const result = await tool.execute("call_granted", { program: "node", args: [] });
    expect(JSON.stringify(result.content)).toContain("out.pptx");
  });
});
