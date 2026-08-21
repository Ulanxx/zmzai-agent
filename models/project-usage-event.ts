import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const projectUsageEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true, immutable: true },
  projectId: { type: String, required: true, immutable: true, index: true },
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

projectUsageEventSchema.index({ projectId: 1, createdAt: -1 });
export type ProjectUsageEventRecord = InferSchemaType<typeof projectUsageEventSchema>;
export const ProjectUsageEventModel =
  (models.ZmzaiProjectUsageEvent as Model<ProjectUsageEventRecord> | undefined) ??
  model<ProjectUsageEventRecord>("ZmzaiProjectUsageEvent", projectUsageEventSchema);
