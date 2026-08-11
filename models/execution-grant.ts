import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const executionGrantSchema = new Schema(
  {
    grantId: { type: String, required: true, unique: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    // The exec proposal approval that created this grant.
    sourceProposalId: { type: String, required: true, immutable: true },
    createdAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    remainingCommands: { type: Number, required: true, min: 0, default: 20 },
    remainingWallTimeMs: { type: Number, required: true, min: 0, default: 10 * 60 * 1000 },
    revokedAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

// At most one active (non-revoked) grant per run.
executionGrantSchema.index({ runId: 1, revokedAt: 1 }, { unique: true, partialFilterExpression: { revokedAt: null } });
executionGrantSchema.index({ userId: 1, grantId: 1 });
executionGrantSchema.index({ expiresAt: 1 });

export type ExecutionGrantRecord = InferSchemaType<typeof executionGrantSchema>;
export const ExecutionGrantModel = (models.ZmzaiAgentExecutionGrant as Model<ExecutionGrantRecord> | undefined) ?? model<ExecutionGrantRecord>("ZmzaiAgentExecutionGrant", executionGrantSchema);
