import { describe, expect, it } from "vitest";

import { latestQaCheckStatus, qualityGateFailureReason } from "./task-quality-gate";
import type { PersistedFrameworkEvent } from "@zmzai/agent-framework";

function qa(seq: number, status: "passed" | "failed"): PersistedFrameworkEvent {
  return {
    id: `evt_${seq}`,
    sessionId: "ses_1",
    seq,
    at: new Date(seq * 1_000).toISOString(),
    type: "message.part.updated",
    data: {
      part: {
        id: `part_${seq}`,
        sessionId: "ses_1",
        messageId: "msg_1",
        type: "tool",
        callId: `call_${seq}`,
        tool: "qa-check",
        state: {
          status: "completed",
          input: { entryPath: "index.html" },
          output: "{}",
          title: "质量检查",
          metadata: { qaCheck: { status } },
          time: { start: "2026-08-20T00:00:00.000Z", end: "2026-08-20T00:00:01.000Z" },
        },
      },
    },
  };
}

function webApp(seq: number): PersistedFrameworkEvent {
  return {
    id: `evt_${seq}`,
    sessionId: "ses_1",
    seq,
    at: new Date(seq * 1_000).toISOString(),
    type: "artifact.created",
    data: {
      artifactId: "art_index",
      path: "index.html",
      bytes: 64,
      contentType: "text/html",
      downloadUrl: "/download",
      previewUrl: "/preview",
    },
  };
}

describe("task quality gate", () => {
  it("uses the most recent completed qa-check result", () => {
    expect(latestQaCheckStatus([qa(2, "passed"), qa(1, "failed")])).toBe("passed");
    expect(qualityGateFailureReason([qa(3, "failed")])).toBe("QA_CHECK_FAILED");
    expect(qualityGateFailureReason([])).toBeNull();
  });

  it("requires a passed check before a generated web app can complete", () => {
    expect(qualityGateFailureReason([webApp(1)])).toBe("QA_CHECK_REQUIRED");
    expect(qualityGateFailureReason([webApp(1), qa(2, "passed")])).toBeNull();
    expect(qualityGateFailureReason([webApp(1), qa(2, "failed")])).toBe("QA_CHECK_FAILED");
  });
});
