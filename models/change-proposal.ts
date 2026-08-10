import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const proposalChangeSchema = new Schema(
  {
    path: { type: String, required: true, maxlength: 512 },
    operation: { type: String, enum: ["create", "update", "delete"], required: true },
    before: { type: String, default: null },
    after: { type: String, default: null },
  },
  { _id: false, strict: "throw" },
);

const changeProposalSchema = new Schema(
  {
    proposalId: { type: String, required: true, unique: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    baseRevisionId: { type: String, default: null, immutable: true },
    status: { type: String, enum: ["pending", "approved", "rejected", "superseded"], required: true, default: "pending" },
    approvedRevisionId: { type: String, default: null },
    changes: { type: [proposalChangeSchema], required: true },
    diff: { type: String, required: true, maxlength: 1024 * 1024 },
    summary: { type: String, required: true, maxlength: 2_000 },
  },
  { strict: "throw", timestamps: true },
);

changeProposalSchema.index({ runId: 1, createdAt: 1 });
changeProposalSchema.index({ userId: 1, proposalId: 1 });
changeProposalSchema.index({ runId: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });

export type ChangeProposalRecord = InferSchemaType<typeof changeProposalSchema>;
export const ChangeProposalModel = (models.ZmzaiAgentChangeProposal as Model<ChangeProposalRecord> | undefined) ?? model<ChangeProposalRecord>("ZmzaiAgentChangeProposal", changeProposalSchema);
