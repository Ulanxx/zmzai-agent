import { appendTaskEvent } from "@/lib/task-events";
import { getExecutionProposal, updateExecutionResult } from "@/lib/execution-proposals";
import { buildExecSnapshot, SnapshotError } from "@/lib/sandbox-snapshot";
import { createAgentSandboxRun, getAgentSandboxRun, streamAgentSandboxEvents, AgentSandboxError } from "@/lib/sandbox-client";

const maxArtifactBytes = 64 * 1024;
const maxResultSummaryBytes = 4 * 1024;

const globalExecutions = globalThis as typeof globalThis & { __zmzaiAgentActiveExecutions?: Map<string, AbortController> };
const executions = globalExecutions.__zmzaiAgentActiveExecutions ?? new Map<string, AbortController>();
globalExecutions.__zmzaiAgentActiveExecutions = executions;

export function abortActiveExecution(runId: string): void {
  executions.get(runId)?.abort();
}

function truncateBytes(value: string, limit: number): { text: string; truncated: boolean; omittedBytes: number } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= limit) return { text: value, truncated: false, omittedBytes: 0 };
  let text = value;
  while (Buffer.byteLength(text, "utf8") > limit) text = text.slice(0, -1);
  return { text, truncated: true, omittedBytes: bytes - Buffer.byteLength(text, "utf8") };
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
 * into the task event stream as an `execution_output` artifact, finishing the
 * exec tool node with the real result. Runs even when the in-memory Agent is
 * gone (process restart) so the approved execution is never silently dropped.
 */
export async function resumeApprovedExecution(input: { userId: string; runId: string; workspaceId: string; proposalId: string }): Promise<ApprovedExecutionResult> {
  const proposal = await getExecutionProposal({ userId: input.userId, proposalId: input.proposalId });
  if (!proposal || proposal.status !== "approved") {
    return { ok: false, toolCallId: proposal?.toolCallId ?? "exec", exitCode: null, outputText: "", durationMs: 0, sandboxRunId: null, errorMessage: "执行提案不可用" };
  }
  const startedAt = Date.now();
  const commandLabel = [proposal.program, ...proposal.args].join(" ");
  const controller = new AbortController();
  executions.set(input.runId, controller);

  const emitToolEnd = async (failed: boolean, resultSummary: { text: string; truncated: boolean; omittedBytes: number }) => {
    try {
      await appendTaskEvent({ runId: input.runId, userId: input.userId, type: failed ? "tool.failed" : "tool.completed", data: { toolCallId: proposal.toolCallId, name: "exec", durationMs: Date.now() - startedAt, resultSummary } });
    } catch { /* event budget exhausted — the run will fail with EVENT_BUDGET_EXCEEDED */ }
  };

  const safeAppend = async (event: { type: string; data: Record<string, unknown> }) => {
    try {
      await appendTaskEvent({ runId: input.runId, userId: input.userId, ...event });
    } catch { /* budget guard: drop non-terminal events when over budget */ }
  };

  try {
    await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "tool.progress", data: { toolCallId: proposal.toolCallId, name: "exec", label: "正在准备沙箱" } });

    let built;
    try {
      built = await buildExecSnapshot({ userId: input.userId, workspaceId: input.workspaceId, runId: input.runId });
    } catch (error) {
      const message = error instanceof SnapshotError ? error.message : "影子快照构建失败";
      await emitToolEnd(true, { text: message, truncated: false, omittedBytes: 0 });
      return { ok: false, toolCallId: proposal.toolCallId, exitCode: null, outputText: "", durationMs: Date.now() - startedAt, sandboxRunId: null, errorMessage: message };
    }

    await safeAppend({ type: "artifact.upsert", data: { artifactId: `artifact_${proposal.toolCallId}`, toolCallId: proposal.toolCallId, kind: "execution_output", title: commandLabel, payload: { content: "", truncated: false, omittedBytes: 0 } } });

    let sandboxRunId: string | null = null;
    const outputParts: string[] = [];
    let outputBytes = 0;
    const pushOutput = async (text: string) => {
      if (!text) return;
      const bytes = Buffer.byteLength(text, "utf8");
      const offset = outputBytes;
      if (outputBytes + bytes > maxArtifactBytes) {
        const room = maxArtifactBytes - outputBytes;
        if (room > 0) {
          const sliced = text.slice(0, Math.max(0, room));
          outputParts.push(sliced);
          outputBytes += Buffer.byteLength(sliced, "utf8");
          await safeAppend({ type: "artifact.append", data: { artifactId: `artifact_${proposal.toolCallId}`, offset, text: sliced, truncated: false, omittedBytes: 0 } });
        }
        await safeAppend({ type: "artifact.append", data: { artifactId: `artifact_${proposal.toolCallId}`, offset: outputBytes, text: "", truncated: true, omittedBytes: 0 } });
        return;
      }
      outputParts.push(text);
      outputBytes += bytes;
      await safeAppend({ type: "artifact.append", data: { artifactId: `artifact_${proposal.toolCallId}`, offset, text, truncated: false, omittedBytes: 0 } });
    };

    try {
      await safeAppend({ type: "tool.progress", data: { toolCallId: proposal.toolCallId, name: "exec", label: "沙箱执行中" } });
      const created = await createAgentSandboxRun({
        userId: input.userId,
        taskRunId: input.runId,
        requestId: proposal.id,
        snapshot: built.snapshot,
        command: { program: proposal.program, args: proposal.args, ...(proposal.cwd ? { cwd: proposal.cwd } : {}), ...(Object.keys(proposal.env).length ? { envs: proposal.env } : {}) },
        limits: { timeoutMs: 60000, cpuMillis: 500, memoryMiB: 512 },
      });
      sandboxRunId = created.id;
      await updateExecutionResult({ proposalId: proposal.id, sandboxRunId: created.id, resultSummary: null, exitCode: null, durationMs: null });

      await streamAgentSandboxEvents(created.id, (event) => {
        if (event.type === "sandbox.output" && event.text) void pushOutput(event.text);
      }, controller.signal);

      const final = await getAgentSandboxRun(created.id);
      const failed = final?.status === "failed" || final?.status === "cancelled" || (final?.exitCode ?? 0) !== 0;
      const exitCode = final?.exitCode ?? (failed ? 1 : 0);
      const outputText = outputParts.join("");
      const summary = truncateBytes(outputText.slice(-maxResultSummaryBytes * 2), maxResultSummaryBytes);
      await emitToolEnd(failed, summary);
      await updateExecutionResult({ proposalId: proposal.id, sandboxRunId: created.id, resultSummary: summary.text, exitCode, durationMs: Date.now() - startedAt });
      return { ok: !failed, toolCallId: proposal.toolCallId, exitCode, outputText, durationMs: Date.now() - startedAt, sandboxRunId: created.id, errorMessage: failed ? `命令以退出码 ${exitCode} 结束` : null };
    } catch (error) {
      const message = error instanceof AgentSandboxError ? error.message : error instanceof Error ? error.message : "沙箱执行失败";
      if (controller.signal.aborted) {
        await emitToolEnd(true, { text: "执行已取消", truncated: false, omittedBytes: 0 });
      } else {
        await emitToolEnd(true, { text: message, truncated: false, omittedBytes: 0 });
      }
      await updateExecutionResult({ proposalId: proposal.id, sandboxRunId, resultSummary: message, exitCode: 1, durationMs: Date.now() - startedAt });
      return { ok: false, toolCallId: proposal.toolCallId, exitCode: 1, outputText: outputParts.join(""), durationMs: Date.now() - startedAt, sandboxRunId, errorMessage: message };
    }
  } finally {
    executions.delete(input.runId);
  }
}
