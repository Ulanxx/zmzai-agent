import { listRunProposals } from "@/lib/proposals";
import { listTaskEvents } from "@/lib/task-events";
import { TaskRunModel, type TaskRunRecord } from "@/models/task-run";

/** Maximum number of prior turns included in the seeded continuation context. */
const maxContextRuns = 12;
/** Soft total budget for the compacted history text. */
const maxContextBytes = 64 * 1024;
/** Per-turn caps so one noisy turn cannot starve the rest. */
const maxReplyBytes = 8 * 1024;
const maxPromptBytes = 4 * 1024;

const terminalStates = ["succeeded", "failed", "cancelled"] as const;

export class ContinuationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContinuationError";
  }
}

/**
 * Validates that `continueFromRunId` can be continued: it must belong to the
 * same user and workspace, and must have reached a terminal state.
 * Returns the sessionId to reuse and the parentRunId for the new run.
 */
export async function prepareContinuation(input: { userId: string; workspaceId: string; continueFromRunId: string }): Promise<{ sessionId: string; parentRunId: string }> {
  const previous = await TaskRunModel.findOne({ runId: input.continueFromRunId, userId: input.userId }).lean();
  if (!previous) throw new ContinuationError("CONTINUATION_NOT_FOUND", "要延续的任务不存在");
  if (previous.workspaceId !== input.workspaceId) throw new ContinuationError("CONTINUATION_WORKSPACE_MISMATCH", "不能跨 Workspace 延续任务");
  if (!(terminalStates as readonly string[]).includes(previous.status)) throw new ContinuationError("CONTINUATION_NOT_TERMINAL", "只有已结束的任务才能继续对话");
  return { sessionId: previous.sessionId, parentRunId: previous.runId };
}

function truncateBytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let text = value;
  while (Buffer.byteLength(text, "utf8") > limit) text = text.slice(0, -1);
  return `${text}\n…（已截断）`;
}

function outcomeNote(run: TaskRunRecord, errorMessage: string | null, proposalSummary: { status: string; approvedRevisionId: string | null } | null): string {
  if (run.status === "failed") {
    const detail = errorMessage ? `：${errorMessage}` : run.failureCode ? `（${run.failureCode}）` : "";
    return `任务失败${detail}`;
  }
  if (run.status === "cancelled") return "任务被取消";
  if (proposalSummary) {
    if (proposalSummary.status === "approved" && proposalSummary.approvedRevisionId) return `文件变更提案已批准，已提交为版本 ${proposalSummary.approvedRevisionId}`;
    if (proposalSummary.status === "approved") return "文件变更提案已批准，已提交为新版本";
    if (proposalSummary.status === "rejected") return "文件变更提案被拒绝，Workspace 文件未改变";
    if (proposalSummary.status === "superseded") return "文件变更提案因版本冲突过期，未被提交";
  }
  return "任务完成";
}

/**
 * Rebuilds a compact model-visible summary of the conversation up to (and
 * including) `runId`. The Agent for a continuation run is seeded with this
 * single user message so it can keep working with context after the previous
 * turn completed, failed, or was cancelled.
 *
 * Only persisted state is used (run records + events + proposals), so the
 * context survives process restarts. Raw tool outputs are not persisted; tool
 * activity is summarized from event metadata.
 */
export async function buildContinuationMessages(input: { userId: string; runId: string }): Promise<Array<{ role: "user"; content: string; timestamp: number }>> {
  const anchor = await TaskRunModel.findOne({ runId: input.runId, userId: input.userId }).lean();
  if (!anchor) return [];

  const runs = await TaskRunModel.find({ userId: input.userId, sessionId: anchor.sessionId, status: { $in: [...terminalStates] } })
    .sort({ createdAt: 1 })
    .lean();

  const blocks: string[] = [];
  let budget = maxContextBytes;
  for (const run of runs.slice(-maxContextRuns)) {
    const events = await listTaskEvents(run.runId, 0);
    const deltas = new Map<string, string>();
    const toolCounts = new Map<string, number>();
    let errorMessage: string | null = null;
    for (const event of events) {
      const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
      if (event.type === "message.delta") {
        const messageId = typeof data.messageId === "string" ? data.messageId : "legacy";
        deltas.set(messageId, `${deltas.get(messageId) ?? ""}${typeof data.delta === "string" ? data.delta : ""}`);
      }
      if (event.type === "tool.requested" && typeof data.name === "string") toolCounts.set(data.name, (toolCounts.get(data.name) ?? 0) + 1);
      if (event.type === "run.failed" && typeof data.error === "string") errorMessage = data.error;
    }

    const proposals = await listRunProposals({ userId: input.userId, runId: run.runId });
    const latestProposal = proposals.length ? [...proposals].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1) : null;
    const tools = [...toolCounts.entries()].map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join("、") || "无";

    const lines: string[] = [];
    lines.push(`用户请求：${truncateBytes(run.prompt, maxPromptBytes)}`);
    const replies = [...deltas.values()].filter((text) => text.trim().length > 0);
    if (replies.length) lines.push(`Agent 回复：${truncateBytes(replies.join("\n"), maxReplyBytes)}`);
    lines.push(`工具活动：${tools}`);
    lines.push(`结局：${outcomeNote(run, errorMessage, latestProposal ? { status: latestProposal.status, approvedRevisionId: latestProposal.approvedRevisionId } : null)}`);

    const block = `第 ${runs.indexOf(run) + 1} 轮（${run.mode} · ${run.model}）\n${lines.join("\n")}`;
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (budget - blockBytes <= 0 && blocks.length > 0) break;
    blocks.push(block);
    budget -= blockBytes;
  }

  if (!blocks.length) return [];
  const content = `以下是本次会话在之前几轮的历史摘要，请基于这些上下文继续当前任务：\n\n${blocks.join("\n\n")}`;
  return [{ role: "user", content, timestamp: Date.now() }];
}
