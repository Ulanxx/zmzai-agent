import { describe, expect, it } from "vitest";

import { summarizeProductMetrics } from "@/lib/product-metrics";

describe("P0 product metrics", () => {
  it("calculates the five launch metrics without counting undelivered artifacts", () => {
    const metrics = summarizeProductMetrics({
      taskStatuses: ["succeeded", "failed", "cancelled", "active"],
      runs: [
        { runId: "run_failed", parentRunId: null, status: "failed" },
        { runId: "run_recovered", parentRunId: "run_failed", status: "succeeded" },
        { runId: "run_other", parentRunId: null, status: "succeeded" },
      ],
      approvals: [{ status: "approved" }, { status: "rejected" }, { status: "pending" }],
      events: [
        { kind: "artifact_downloaded", taskId: "task_a", artifactId: "artifact_a" },
        { kind: "task_followed_up", taskId: "task_a", artifactId: null },
      ],
      artifactIds: ["artifact_a", "artifact_b"],
    });

    expect(metrics.taskCompletionRate).toMatchObject({ numerator: 1, denominator: 3, percent: 33.33 });
    expect(metrics.failureRecoveryRate).toMatchObject({ numerator: 1, denominator: 1, percent: 100 });
    expect(metrics.artifactDownloadRate).toMatchObject({ numerator: 1, denominator: 2, percent: 50 });
    expect(metrics.proactiveContinuationRate).toMatchObject({ numerator: 1, denominator: 1, percent: 100 });
    expect(metrics.permissionRejectionRate).toMatchObject({ numerator: 1, denominator: 2, percent: 50 });
  });
});
