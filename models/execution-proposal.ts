import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

export const executionProposalStates = ["pending", "approved", "rejected", "superseded"] as const;

const snapshotSummarySchema = new Schema(
  {
    revisionId: { type: String, default: null },
    fileCount: { type: Number, required: true, default: 0 },
    totalBytes: { type: Number, required: true, default: 0 },
    files: { type: [String], default: [] },
  },
  { _id: false, strict: "throw" },
);

const executionProposalSchema = new Schema(
  {
    proposalId: { type: String, required: true, unique: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    toolCallId: { type: String, required: true, immutable: true },
    // The command is structured and allowlisted by the exec Tool Broker; the
    // Sandbox enforces the same allowlist again before executing.
    program: { type: String, required: true, immutable: true, maxlength: 64 },
    args: { type: [String], required: true, default: [], maxlength: 64 },
    cwd: { type: String, default: null, maxlength: 512 },
    env: { type: Schema.Types.Mixed, default: {} },
    snapshotSummary: { type: snapshotSummarySchema, required: true },
    status: { type: String, enum: executionProposalStates, required: true, default: "pending" },
    sandboxRunId: { type: String, default: null },
    resultSummary: { type: String, default: null },
    exitCode: { type: Number, default: null },
    durationMs: { type: Number, default: null },
  },
  { strict: "throw", timestamps: true },
);

executionProposalSchema.index({ runId: 1, createdAt: 1 });
executionProposalSchema.index({ userId: 1, proposalId: 1 });
// One pending execution per run, mirroring the change-proposal constraint.
executionProposalSchema.index({ runId: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });

export type ExecutionProposalRecord = InferSchemaType<typeof executionProposalSchema>;
export const ExecutionProposalModel = (models.ZmzaiAgentExecutionProposal as Model<ExecutionProposalRecord> | undefined) ?? model<ExecutionProposalRecord>("ZmzaiAgentExecutionProposal", executionProposalSchema);
