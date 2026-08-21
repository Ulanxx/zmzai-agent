import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const workspaceUsageEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true, immutable: true },
  workspaceId: { type: String, required: true, immutable: true, index: true },
  userId: { type: String, required: true, immutable: true, index: true },
  taskId: { type: String, required: true, immutable: true, index: true },
  runId: { type: String, required: true, immutable: true, index: true },
  sessionId: { type: String, required: true, immutable: true },
  inputTokens: { type: Number, required: true, min: 0 },
  outputTokens: { type: Number, required: true, min: 0 },
  cacheReadTokens: { type: Number, required: true, min: 0 },
  cacheWriteTokens: { type: Number, required: true, min: 0 },
  totalTokens: { type: Number, required: true, min: 0 },
}, { strict: "throw", timestamps: true });

workspaceUsageEventSchema.index({ workspaceId: 1, createdAt: -1 });
export type WorkspaceUsageEventRecord = InferSchemaType<typeof workspaceUsageEventSchema>;
export const WorkspaceUsageEventModel =
  (models.ZmzaiWorkspaceUsageEvent as Model<WorkspaceUsageEventRecord> | undefined) ??
  model<WorkspaceUsageEventRecord>("ZmzaiWorkspaceUsageEvent", workspaceUsageEventSchema);
