import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const approvalRequestSchema = new Schema(
  {
    requestId: { type: String, required: true, unique: true, immutable: true },
    taskId: { type: String, required: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    requesterId: { type: String, required: true, immutable: true },
    action: { type: String, required: true, maxlength: 160, immutable: true },
    impact: { type: String, required: true, maxlength: 2_000, immutable: true },
    resourceScope: { type: [String], required: true, default: [], immutable: true },
    status: { type: String, enum: ["pending", "approved", "rejected", "expired", "revoked"], required: true, default: "pending" },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    feedback: { type: String, default: null, maxlength: 2_000 },
    // The request is created before a user decides whether this is a one-off
    // or continuing approval. `projectApprovalReply` assigns this exactly
    // once when an "always" decision creates its grant.
    grantId: { type: String, default: null },
  },
  { strict: "throw", timestamps: true },
);

approvalRequestSchema.index({ taskId: 1, createdAt: -1 });
approvalRequestSchema.index({ runId: 1, status: 1 });

const approvalGrantSchema = new Schema(
  {
    grantId: { type: String, required: true, unique: true, immutable: true },
    taskId: { type: String, required: true, immutable: true },
    sourceRequestId: { type: String, required: true, immutable: true },
    sourceRunId: { type: String, required: true, immutable: true },
    grantedBy: { type: String, required: true, immutable: true },
    action: { type: String, required: true, maxlength: 160, immutable: true },
    resourceScope: { type: [String], required: true, default: [], immutable: true },
    allowContinuation: { type: Boolean, required: true, default: false, immutable: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

approvalGrantSchema.index({ taskId: 1, expiresAt: 1 });
approvalGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type ApprovalRequestRecord = InferSchemaType<typeof approvalRequestSchema>;
export type ApprovalGrantRecord = InferSchemaType<typeof approvalGrantSchema>;
export const ApprovalRequestModel =
  (models.ZmzaiAgentApprovalRequest as Model<ApprovalRequestRecord> | undefined) ??
  model<ApprovalRequestRecord>("ZmzaiAgentApprovalRequest", approvalRequestSchema);
export const ApprovalGrantModel =
  (models.ZmzaiAgentApprovalGrant as Model<ApprovalGrantRecord> | undefined) ?? model<ApprovalGrantRecord>("ZmzaiAgentApprovalGrant", approvalGrantSchema);
