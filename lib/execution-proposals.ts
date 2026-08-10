import { ExecutionProposalModel, type ExecutionProposalRecord } from "@/models/execution-proposal";
import { TaskRunModel } from "@/models/task-run";
import type { ExecSnapshotSummary } from "@/lib/sandbox-snapshot";

export type ExecutionProposalView = {
  id: string;
  runId: string;
  workspaceId: string;
  kind: "exec";
  toolCallId: string;
  program: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  snapshotSummary: { revisionId: string | null; fileCount: number; totalBytes: number; files: string[] };
  status: "pending" | "approved" | "rejected" | "superseded";
  sandboxRunId: string | null;
  resultSummary: string | null;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};

function toView(record: ExecutionProposalRecord): ExecutionProposalView {
  return {
    id: record.proposalId,
    runId: record.runId,
    workspaceId: record.workspaceId,
    kind: "exec",
    toolCallId: record.toolCallId,
    program: record.program,
    args: record.args,
    cwd: record.cwd ?? null,
    env: record.env as Record<string, string> | undefined ?? {},
    snapshotSummary: record.snapshotSummary as { revisionId: string | null; fileCount: number; totalBytes: number; files: string[] },
    status: record.status,
    sandboxRunId: record.sandboxRunId ?? null,
    resultSummary: record.resultSummary ?? null,
    exitCode: record.exitCode ?? null,
    durationMs: record.durationMs ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function listRunExecutionProposals(input: { userId: string; runId: string }): Promise<ExecutionProposalView[]> {
  const proposals = await ExecutionProposalModel.find({ runId: input.runId, userId: input.userId }).sort({ createdAt: 1 }).lean();
  return proposals.map(toView);
}

export async function getExecutionProposal(input: { userId: string; proposalId: string }): Promise<ExecutionProposalView | null> {
  const proposal = await ExecutionProposalModel.findOne({ proposalId: input.proposalId, userId: input.userId }).lean();
  return proposal ? toView(proposal) : null;
}

export async function hasPendingExecutions(runId: string): Promise<boolean> {
  return (await ExecutionProposalModel.exists({ runId, status: "pending" })) !== null;
}

export async function createPendingExecution(input: { userId: string; workspaceId: string; runId: string; toolCallId: string; program: string; args: string[]; cwd?: string | null; env: Record<string, string>; snapshotSummary: ExecSnapshotSummary }): Promise<ExecutionProposalView> {
  const existing = await ExecutionProposalModel.findOne({ runId: input.runId, status: "pending" }).lean();
  if (existing) throw new Error("EXEC_ALREADY_PENDING");
  const record = await ExecutionProposalModel.create({
    proposalId: `exec_${crypto.randomUUID()}`,
    runId: input.runId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    toolCallId: input.toolCallId,
    program: input.program,
    args: input.args,
    cwd: input.cwd ?? null,
    env: input.env,
    snapshotSummary: input.snapshotSummary,
    status: "pending",
  });
  return toView(record);
}

export type ExecutionResolution = { outcome: "approved" | "rejected" | "conflict" | "not_ready"; proposal: ExecutionProposalView };

/**
 * Resolves a pending execution proposal with compare-and-set semantics.
 * Approval is only allowed while the run is waiting_approval; rejection is
 * always allowed for a pending proposal. A lost race re-reads the winner.
 */
export async function resolveExecutionProposal(input: { userId: string; proposalId: string; action: "approve" | "reject" }): Promise<ExecutionResolution | null> {
  const proposal = await ExecutionProposalModel.findOne({ proposalId: input.proposalId, userId: input.userId }).lean();
  if (!proposal) return null;
  if (proposal.status !== "pending") return { outcome: proposal.status === "approved" ? "approved" : "rejected", proposal: toView(proposal) };

  if (input.action === "approve") {
    const run = await TaskRunModel.findOne({ runId: proposal.runId, userId: input.userId, status: "waiting_approval" }).lean();
    if (!run) return { outcome: "not_ready", proposal: toView(proposal) };
  }

  const resolved = await ExecutionProposalModel.findOneAndUpdate(
    { proposalId: input.proposalId, userId: input.userId, status: "pending" },
    { $set: { status: input.action === "approve" ? "approved" : "rejected" } },
    { new: true },
  ).lean();
  if (!resolved) {
    const current = await ExecutionProposalModel.findOne({ proposalId: input.proposalId, userId: input.userId }).lean();
    if (!current) return null;
    return { outcome: current.status === "approved" ? "approved" : "rejected", proposal: toView(current) };
  }
  return { outcome: input.action === "approve" ? "approved" : "rejected", proposal: toView(resolved) };
}

export async function updateExecutionResult(input: { proposalId: string; sandboxRunId: string | null; resultSummary: string | null; exitCode: number | null; durationMs: number | null }): Promise<void> {
  await ExecutionProposalModel.updateOne({ proposalId: input.proposalId }, { $set: { sandboxRunId: input.sandboxRunId, resultSummary: input.resultSummary, exitCode: input.exitCode, durationMs: input.durationMs } });
}
