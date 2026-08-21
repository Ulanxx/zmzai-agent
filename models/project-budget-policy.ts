import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const projectBudgetPolicySchema = new Schema({
  projectId: { type: String, required: true, unique: true, immutable: true, index: true },
  userId: { type: String, required: true, immutable: true, index: true },
  maxConcurrentRuns: { type: Number, required: true, min: 1, max: 32, default: 4 },
  monthlyTokenBudget: { type: Number, required: true, min: 0, default: 0 },
  usedTokens: { type: Number, required: true, min: 0, default: 0 },
  usagePeriod: { type: String, required: true, maxlength: 7 },
  reservedRuns: { type: Number, required: true, min: 0, default: 0 },
}, { strict: "throw", timestamps: true });

export type ProjectBudgetPolicyRecord = InferSchemaType<typeof projectBudgetPolicySchema>;
export const ProjectBudgetPolicyModel = (models.ZmzaiProjectBudgetPolicy as Model<ProjectBudgetPolicyRecord> | undefined) ?? model<ProjectBudgetPolicyRecord>("ZmzaiProjectBudgetPolicy", projectBudgetPolicySchema);
