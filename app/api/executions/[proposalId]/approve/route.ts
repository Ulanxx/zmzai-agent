import { NextRequest, NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { resumeAgentRun } from "@/lib/agent-runtime";
import { getCurrentUser } from "@/lib/auth/session";
import { createExecutionGrant } from "@/lib/execution-grants";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { getExecutionProposal, resolveExecutionProposal } from "@/lib/execution-proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ proposalId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { proposalId } = await context.params;
  try {
    const claim = await claimIdempotency({
      userId: user.id,
      scope: `execution.${proposalId}.approve`,
      key: request.headers.get("idempotency-key"),
      body: {},
      resourceId: proposalId,
    });
    if (claim.replayed) {
      const proposal = await getExecutionProposal({ userId: user.id, proposalId });
      if (!proposal) return apiError("PROPOSAL_NOT_FOUND", 404, "执行提案不存在");
      if (proposal.status === "pending") return apiError("IDEMPOTENCY_RECOVERY_PENDING", 409, "请求正在恢复，请稍后重试");
      return NextResponse.json({ proposal, replayed: true }, { headers: { "cache-control": "no-store" } });
    }

    const resolved = await resolveExecutionProposal({ userId: user.id, proposalId, action: "approve" });
    if (!resolved) return apiError("PROPOSAL_NOT_FOUND", 404, "执行提案不存在");
    if (resolved.outcome === "not_ready") return apiError("EXECUTION_NOT_READY", 409, "Agent 尚未完成执行提案，请等待任务进入审批状态");
    if (resolved.outcome === "conflict") return apiError("EXECUTION_CONFLICT", 409, "执行提案状态已变化，不能批准");
    if (resolved.outcome === "approved") {
      const commandLabel = [resolved.proposal.program, ...resolved.proposal.args].join(" ");
      // Approving the execution plan grants the task permission to run further
      // commands directly (spec §6.3) until the budget is exhausted.
      await createExecutionGrant({ userId: user.id, workspaceId: resolved.proposal.workspaceId, runId: resolved.proposal.runId, sourceProposalId: resolved.proposal.id });
      void resumeAgentRun({
        userId: user.id,
        runId: resolved.proposal.runId,
        kind: "exec",
        proposalId: resolved.proposal.id,
        note: `执行已批准：${commandLabel}。本任务已获得执行授权，后续命令可直接运行；沙箱运行结果已作为工具结果返回，请基于结果继续你的工作，或完成任务并总结。`,
      }).catch((error: unknown) => {
        console.error("Agent execution resume failed", { runId: resolved.proposal.runId, error: error instanceof Error ? error.message : "unknown" });
      });
    }
    return NextResponse.json({ proposal: resolved.proposal, replayed: false }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
