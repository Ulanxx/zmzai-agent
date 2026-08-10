import { NextRequest, NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { resumeAgentRun } from "@/lib/agent-runtime";
import { getCurrentUser } from "@/lib/auth/session";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { getProposal, resolveProposal } from "@/lib/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ proposalId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { proposalId } = await context.params;
  try {
    const claim = await claimIdempotency({
      userId: user.id,
      scope: `proposal.${proposalId}.approve`,
      key: request.headers.get("idempotency-key"),
      body: {},
      resourceId: proposalId,
    });
    if (claim.replayed) {
      const proposal = await getProposal({ userId: user.id, proposalId });
      if (!proposal) return apiError("PROPOSAL_NOT_FOUND", 404, "提案不存在");
      if (proposal.status === "pending") return apiError("IDEMPOTENCY_RECOVERY_PENDING", 409, "请求正在恢复，请稍后重试");
      if (proposal.status === "superseded") return apiError("REVISION_CONFLICT", 409, "Workspace 已有更新版本，请重新生成提案");
      return NextResponse.json({ proposal, revisionId: proposal.approvedRevisionId, replayed: true }, { headers: { "cache-control": "no-store" } });
    }

    const resolved = await resolveProposal({ userId: user.id, proposalId, action: "approve" });
    if (!resolved) return apiError("PROPOSAL_NOT_FOUND", 404, "提案不存在");
    if (resolved.outcome === "not_ready") return apiError("PROPOSAL_NOT_READY", 409, "Agent 尚未完成提案，请等待任务进入审批状态");
    if (resolved.outcome === "conflict") return apiError("REVISION_CONFLICT", 409, "Workspace 已有更新版本，请重新生成提案");
    if (resolved.outcome === "rejected") return apiError("PROPOSAL_NOT_PENDING", 409, "提案已被拒绝，不能批准");
    if (resolved.outcome === "approved") {
      const revisionNote = resolved.revisionId ? `已提交为版本 ${resolved.revisionId}` : "已提交为新版本";
      void resumeAgentRun({
        userId: user.id,
        runId: resolved.proposal.runId,
        kind: "change",
        note: `文件变更提案已批准，${revisionNote}。请继续你的工作，或完成任务并总结。`,
      }).catch((error: unknown) => {
        console.error("Agent resume failed", { runId: resolved.proposal.runId, error: error instanceof Error ? error.message : "unknown" });
      });
    }
    return NextResponse.json({ proposal: resolved.proposal, revisionId: resolved.revisionId, replayed: false }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
