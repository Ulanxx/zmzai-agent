import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

/** One idempotent correction per Project Run. Agent events provide an
 * immediate estimate; Relay's settled Usage ledger is the later authority. */
const projectRelayUsageReconciliationSchema = new Schema({
  runId: { type: String, required: true, unique: true, immutable: true, index: true },
  projectId: { type: String, required: true, immutable: true, index: true },
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

projectRelayUsageReconciliationSchema.index({ projectId: 1, usagePeriod: 1, syncedAt: -1 });
export type ProjectRelayUsageReconciliationRecord = InferSchemaType<typeof projectRelayUsageReconciliationSchema>;
export const ProjectRelayUsageReconciliationModel =
  (models.ZmzaiProjectRelayUsageReconciliation as Model<ProjectRelayUsageReconciliationRecord> | undefined) ??
  model<ProjectRelayUsageReconciliationRecord>("ZmzaiProjectRelayUsageReconciliation", projectRelayUsageReconciliationSchema);
