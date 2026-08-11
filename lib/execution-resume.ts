import { appendTaskEvent } from "@/lib/task-events";
import { getExecutionProposal, updateExecutionResult } from "@/lib/execution-proposals";
import { buildExecSnapshot, SnapshotError } from "@/lib/sandbox-snapshot";
import { runSandboxCommandAndStream } from "@/lib/sandbox-execution";

const globalExecutions = globalThis as typeof globalThis & { __zmzaiAgentActiveExecutions?: Map<string, AbortController> };
const executions = globalExecutions.__zmzaiAgentActiveExecutions ?? new Map<string, AbortController>();
globalExecutions.__zmzaiAgentActiveExecutions = executions;

export function abortActiveExecution(runId: string): void {
  executions.get(runId)?.abort();
}

export type ApprovedExecutionResult = {
  ok: boolean;
  toolCallId: string;
  exitCode: number | null;
  outputText: string;
  durationMs: number;
  sandboxRunId: string | null;
  errorMessage: string | null;
};

/**
 * Runs an approved execution proposal in the Sandbox and streams its output
 * into the task event stream, finishing the exec tool node with the real
 * result and importing any deliverables into GridFS. Runs even when the
 * in-memory Agent is gone (process restart) so an approved execution is never
 * silently dropped.
 */
export async function resumeApprovedExecution(input: { userId: string; runId: string; workspaceId: string; proposalId: string }): Promise<ApprovedExecutionResult> {
  const proposal = await getExecutionProposal({ userId: input.userId, proposalId: input.proposalId });
  if (!proposal || proposal.status !== "approved") {
    return { ok: false, toolCallId: proposal?.toolCallId ?? "exec", exitCode: null, outputText: "", durationMs: 0, sandboxRunId: null, errorMessage: "执行提案不可用" };
  }
  const controller = new AbortController();
  executions.set(input.runId, controller);

  try {
    let built;
    try {
      built = await buildExecSnapshot({ userId: input.userId, workspaceId: input.workspaceId, runId: input.runId });
    } catch (error) {
      const message = error instanceof SnapshotError ? error.message : "影子快照构建失败";
      await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "tool.failed", data: { toolCallId: proposal.toolCallId, name: "exec", durationMs: 0, resultSummary: { text: message, truncated: false, omittedBytes: 0 } } }).catch(() => undefined);
      return { ok: false, toolCallId: proposal.toolCallId, exitCode: null, outputText: "", durationMs: 0, sandboxRunId: null, errorMessage: message };
    }

    const result = await runSandboxCommandAndStream({
      userId: input.userId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      toolCallId: proposal.toolCallId,
      snapshot: built.snapshot,
      command: { program: proposal.program, args: proposal.args, ...(proposal.cwd ? { cwd: proposal.cwd } : {}), ...(Object.keys(proposal.env).length ? { envs: proposal.env } : {}) },
      limits: { timeoutMs: 60000, cpuMillis: 500, memoryMiB: 512 },
    });

    await updateExecutionResult({
      proposalId: proposal.id,
      sandboxRunId: result.sandboxRunId,
      resultSummary: result.outputText.slice(0, 4000) || result.errorMessage,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    }).catch(() => undefined);
    return { ok: result.ok, toolCallId: proposal.toolCallId, exitCode: result.exitCode, outputText: result.outputText, durationMs: result.durationMs, sandboxRunId: result.sandboxRunId, errorMessage: result.errorMessage };
  } finally {
    executions.delete(input.runId);
  }
}
