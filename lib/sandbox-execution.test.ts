import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sandbox-client", () => ({
  getAgentSandboxRun: vi.fn(),
}));

import { getAgentSandboxRun } from "@/lib/sandbox-client";
import { classifySandboxOutcome, waitForSandboxTerminalRun } from "./sandbox-execution";

describe("classifySandboxOutcome", () => {
  it("requires an explicit terminal status", () => {
    expect(classifySandboxOutcome(null)).toBe("unknown");
    expect(classifySandboxOutcome({ status: "running", exitCode: null })).toBe("unknown");
    expect(classifySandboxOutcome({ status: "queued", exitCode: null })).toBe("unknown");
  });

  it("treats only a zero-exit succeeded run as success", () => {
    expect(classifySandboxOutcome({ status: "succeeded", exitCode: 0 })).toBe("succeeded");
    expect(classifySandboxOutcome({ status: "succeeded", exitCode: 1 })).toBe("failed");
    expect(classifySandboxOutcome({ status: "failed", exitCode: 1 })).toBe("failed");
    expect(classifySandboxOutcome({ status: "cancelled", exitCode: null })).toBe("failed");
  });

  it("reconciles a completed run after an interrupted event stream", async () => {
    vi.mocked(getAgentSandboxRun)
      .mockResolvedValueOnce({ status: "running" } as never)
      .mockResolvedValueOnce({ status: "succeeded", exitCode: 0 } as never);

    await expect(waitForSandboxTerminalRun("run_test", 100, 1)).resolves.toMatchObject({ status: "succeeded", exitCode: 0 });
  });
});
