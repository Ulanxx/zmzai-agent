import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

/** One idempotent Relay correction per Workspace Run. Workspace budgets apply
 * to every task, including tasks that do not belong to a Project. */
const workspaceRelayUsageReconciliationSchema = new Schema({
  runId: { type: String, required: true, unique: true, immutable: true, index: true },
  workspaceId: { type: String, required: true, immutable: true, index: true },
  userId: { type: String, required: true, immutable: true, index: true },
  usagePeriod: { type: String, required: true, maxlength: 7 },
  relayInputTokens: { type: Number, required: true, min: 0 },
  relayOutputTokens: { type: Number, required: true, min: 0 },
  relayCacheReadTokens: { type: Number, required: true, min: 0 },
  relayCacheWriteTokens: { type: Number, required: true, min: 0 },
  relayTotalTokens: { type: Number, required: true, min: 0 },
  projectedTotalTokens: { type: Number, required: true, min: 0 },
  appliedDeltaTokens: { type: Number, required: true, default: 0 },
  syncedAt: { type: Date, required: true },
}, { strict: "throw", timestamps: true });

workspaceRelayUsageReconciliationSchema.index({ workspaceId: 1, usagePeriod: 1, syncedAt: -1 });
export type WorkspaceRelayUsageReconciliationRecord = InferSchemaType<typeof workspaceRelayUsageReconciliationSchema>;
export const WorkspaceRelayUsageReconciliationModel =
  (models.ZmzaiWorkspaceRelayUsageReconciliation as Model<WorkspaceRelayUsageReconciliationRecord> | undefined) ??
  model<WorkspaceRelayUsageReconciliationRecord>("ZmzaiWorkspaceRelayUsageReconciliation", workspaceRelayUsageReconciliationSchema);
