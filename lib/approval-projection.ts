import { randomUUID } from "node:crypto";

import type { PersistedFrameworkEvent, PermissionRequest, Reply } from "@zmzai/agent-framework";

import { ApprovalGrantModel, ApprovalRequestModel } from "@/models/approval";
import { CheckpointModel } from "@/models/checkpoint";
import { RunModel } from "@/models/run";

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 2_000) : fallback;
}

function approvalDescription(request: PermissionRequest): string {
  if (request.metadata && typeof request.metadata === "object" && "connectorName" in request.metadata) {
    const metadata = request.metadata as { connectorName?: unknown; toolName?: unknown };
    return `允许 Agent 通过 ${text(metadata.connectorName, "连接器")} 调用 ${text(metadata.toolName, "外部工具")}`;
  }
  return `允许 Agent 执行 ${request.permission} 操作`;
}

function scope(request: PermissionRequest): string[] {
  return request.patterns.map((pattern) => pattern.slice(0, 512));
}

/** Turns ephemeral PermissionEngine requests into task-owned audit records.
 * Events remain authoritative; this is a rebuildable projection that gives
 * task pages and recovery flows stable ApprovalRequest/Grant objects. */
export async function projectApprovalAsked(input: { sessionId: string; request: PermissionRequest }): Promise<void> {
  const run = await RunModel.findOne({ sessionId: input.sessionId, active: true }).sort({ createdAt: -1 }).lean()
    ?? await RunModel.findOne({ sessionId: input.sessionId }).sort({ createdAt: -1 }).lean();
  if (!run) return;
  await ApprovalRequestModel.updateOne(
    { requestId: input.request.id },
    {
      $setOnInsert: {
        requestId: input.request.id,
        taskId: run.taskId,
        runId: run.runId,
        requesterId: run.userId,
        action: input.request.permission.slice(0, 160),
        impact: approvalDescription(input.request),
        resourceScope: scope(input.request),
        status: "pending",
        grantId: null,
      },
    },
    { upsert: true },
  );
}

export async function projectApprovalReply(input: { sessionId: string; requestId: string; reply: Reply; decidedBy?: string | null; feedback?: string | null }): Promise<void> {
  const request = await ApprovalRequestModel.findOne({ requestId: input.requestId, status: "pending" });
  if (!request) return;
  const now = new Date();
  if (input.reply === "reject") {
    await ApprovalRequestModel.updateOne({ requestId: input.requestId, status: "pending" }, { $set: { status: "rejected", decidedBy: input.decidedBy ?? request.requesterId, decidedAt: now, feedback: input.feedback?.slice(0, 2_000) ?? null } });
    return;
  }
  const grantId = input.reply === "always" ? `apg_${randomUUID().replaceAll("-", "").slice(0, 20)}` : null;
  const updated = await ApprovalRequestModel.findOneAndUpdate(
    { requestId: input.requestId, status: "pending" },
    { $set: { status: "approved", decidedBy: input.decidedBy ?? request.requesterId, decidedAt: now, feedback: input.feedback?.slice(0, 2_000) ?? null, ...(grantId ? { grantId } : {}) } },
    { new: true },
  ).lean();
  if (!updated || !grantId) return;
  await ApprovalGrantModel.updateOne(
    { grantId },
    {
      $setOnInsert: {
        grantId,
        taskId: updated.taskId,
        sourceRequestId: updated.requestId,
        sourceRunId: updated.runId,
        grantedBy: updated.decidedBy ?? updated.requesterId,
        action: updated.action,
        resourceScope: updated.resourceScope,
        allowContinuation: false,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
        revokedAt: null,
      },
    },
    { upsert: true },
  );
  await CheckpointModel.findOneAndUpdate(
    { runId: updated.runId },
    { $addToSet: { approvalGrantIds: grantId } },
    { sort: { eventSeq: -1 } },
  );
}

export async function projectApprovalEvent(event: PersistedFrameworkEvent): Promise<void> {
  if (event.type === "permission.asked") return projectApprovalAsked({ sessionId: event.sessionId, request: event.data.request });
  if (event.type === "permission.replied") return projectApprovalReply({ sessionId: event.sessionId, requestId: event.data.id, reply: event.data.reply });
}
