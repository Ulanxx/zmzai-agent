import { ApprovalRequestModel } from "@/models/approval";
import { ProductMetricEventModel } from "@/models/product-metric-event";
import { RunModel } from "@/models/run";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { TaskModel } from "@/models/task";

type MetricRun = { runId: string; parentRunId?: string | null; status: string };
type MetricApproval = { status: string };
type MetricEvent = { kind: string; taskId?: string | null; artifactId?: string | null };

function rate(numerator: number, denominator: number): number | null {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 100 : null;
}

/** Pure aggregation keeps the metric definitions reviewable and independently
 * testable. Percentages are returned as 0-100, or null when no denominator
 * exists in the selected window. */
export function summarizeProductMetrics(input: {
  taskStatuses: string[];
  runs: MetricRun[];
  approvals: MetricApproval[];
  events: MetricEvent[];
  artifactIds: string[];
}) {
  const terminalTasks = input.taskStatuses.filter((status) => ["succeeded", "failed", "cancelled"].includes(status));
  const runsById = new Map(input.runs.map((run) => [run.runId, run]));
  const failedRuns = input.runs.filter((run) => run.status === "failed");
  const recoveredFailures = input.runs.filter((run) => run.status === "succeeded" && run.parentRunId && runsById.get(run.parentRunId)?.status === "failed");
  const deliveredArtifacts = new Set(input.artifactIds);
  const artifactDownloads = new Set(input.events
    .filter((event) => event.kind === "artifact_downloaded" && event.artifactId && deliveredArtifacts.has(event.artifactId))
    .map((event) => event.artifactId));
  const followUpTasks = new Set(input.events.filter((event) => event.kind === "task_followed_up" && event.taskId).map((event) => event.taskId));
  const decidedApprovals = input.approvals.filter((approval) => ["approved", "rejected"].includes(approval.status));

  return {
    taskCompletionRate: { numerator: terminalTasks.filter((status) => status === "succeeded").length, denominator: terminalTasks.length, percent: rate(terminalTasks.filter((status) => status === "succeeded").length, terminalTasks.length) },
    failureRecoveryRate: { numerator: recoveredFailures.length, denominator: failedRuns.length, percent: rate(recoveredFailures.length, failedRuns.length) },
    artifactDownloadRate: { numerator: artifactDownloads.size, denominator: input.artifactIds.length, percent: rate(artifactDownloads.size, input.artifactIds.length) },
    proactiveContinuationRate: { numerator: followUpTasks.size, denominator: terminalTasks.filter((status) => status === "succeeded").length, percent: rate(followUpTasks.size, terminalTasks.filter((status) => status === "succeeded").length) },
    permissionRejectionRate: { numerator: decidedApprovals.filter((approval) => approval.status === "rejected").length, denominator: decidedApprovals.length, percent: rate(decidedApprovals.filter((approval) => approval.status === "rejected").length, decidedApprovals.length) },
  };
}

export async function readProductMetrics(since: Date) {
  const [tasks, runs, approvals, events, artifacts] = await Promise.all([
    TaskModel.find({ updatedAt: { $gte: since } }).select({ status: 1 }).lean(),
    RunModel.find({ createdAt: { $gte: since } }).select({ runId: 1, parentRunId: 1, status: 1 }).lean(),
    ApprovalRequestModel.find({ createdAt: { $gte: since } }).select({ status: 1 }).lean(),
    ProductMetricEventModel.find({ createdAt: { $gte: since } }).select({ kind: 1, taskId: 1, artifactId: 1 }).lean(),
    SandboxArtifactModel.find({ createdAt: { $gte: since }, tooLarge: false }).select({ artifactId: 1 }).lean(),
  ]);
  return summarizeProductMetrics({ taskStatuses: tasks.map((task) => task.status), runs, approvals, events, artifactIds: artifacts.map((artifact) => artifact.artifactId) });
}

export async function recordProductMetric(input: { kind: "artifact_downloaded" | "task_followed_up"; userId: string; taskId?: string | null; runId?: string | null; artifactId?: string | null }) {
  await ProductMetricEventModel.create({
    kind: input.kind,
    userId: input.userId,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    artifactId: input.artifactId ?? null,
  });
}
