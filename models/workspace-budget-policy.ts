import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const workspaceBudgetPolicySchema = new Schema({
  workspaceId: { type: String, required: true, unique: true, immutable: true, index: true },
  userId: { type: String, required: true, immutable: true, index: true },
  maxConcurrentRuns: { type: Number, required: true, min: 1, max: 64, default: 8 },
  monthlyTokenBudget: { type: Number, required: true, min: 0, default: 0 },
  usedTokens: { type: Number, required: true, min: 0, default: 0 },
  usagePeriod: { type: String, required: true, maxlength: 7 },
  reservedRuns: { type: Number, required: true, min: 0, default: 0 },
}, { strict: "throw", timestamps: true });

export type WorkspaceBudgetPolicyRecord = InferSchemaType<typeof workspaceBudgetPolicySchema>;
export const WorkspaceBudgetPolicyModel =
  (models.ZmzaiWorkspaceBudgetPolicy as Model<WorkspaceBudgetPolicyRecord> | undefined) ??
  model<WorkspaceBudgetPolicyRecord>("ZmzaiWorkspaceBudgetPolicy", workspaceBudgetPolicySchema);
