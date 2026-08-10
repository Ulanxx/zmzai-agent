import { NextRequest, NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
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
      scope: `proposal.${proposalId}.reject`,
      key: request.headers.get("idempotency-key"),
      body: {},
      resourceId: proposalId,
    });
    if (claim.replayed) {
      const proposal = await getProposal({ userId: user.id, proposalId });
      if (!proposal) return apiError("PROPOSAL_NOT_FOUND", 404, "提案不存在");
      if (proposal.status === "pending") return apiError("IDEMPOTENCY_RECOVERY_PENDING", 409, "请求正在恢复，请稍后重试");
      if (proposal.status === "superseded") return apiError("PROPOSAL_NOT_PENDING", 409, "提案已过期，不能拒绝");
      return NextResponse.json({ proposal, replayed: true }, { headers: { "cache-control": "no-store" } });
    }

    const resolved = await resolveProposal({ userId: user.id, proposalId, action: "reject" });
    if (!resolved) return apiError("PROPOSAL_NOT_FOUND", 404, "提案不存在");
    if (resolved.outcome === "not_ready") return apiError("PROPOSAL_NOT_READY", 409, "Agent 尚未完成提案，请等待任务进入审批状态");
    if (resolved.outcome === "conflict") return apiError("PROPOSAL_NOT_PENDING", 409, "提案已过期，不能拒绝");
    if (resolved.outcome === "approved") return apiError("PROPOSAL_NOT_PENDING", 409, "提案已批准，不能拒绝");
    return NextResponse.json({ proposal: resolved.proposal, replayed: false }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }
}
