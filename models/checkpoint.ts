import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const checkpointSchema = new Schema(
  {
    checkpointId: { type: String, required: true, unique: true, immutable: true },
    taskId: { type: String, required: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    eventSeq: { type: Number, required: true, min: 0, immutable: true },
    state: { type: Schema.Types.Mixed, required: true, immutable: true },
    completedStepIds: { type: [String], required: true, default: [] },
    completedToolCallIds: { type: [String], required: true, default: [] },
    artifactIds: { type: [String], required: true, default: [] },
    approvalGrantIds: { type: [String], required: true, default: [] },
  },
  { strict: "throw", timestamps: true },
);

checkpointSchema.index({ runId: 1, eventSeq: 1 }, { unique: true });
checkpointSchema.index({ taskId: 1, createdAt: -1 });

export type CheckpointRecord = InferSchemaType<typeof checkpointSchema>;
export const CheckpointModel =
  (models.ZmzaiAgentCheckpoint as Model<CheckpointRecord> | undefined) ?? model<CheckpointRecord>("ZmzaiAgentCheckpoint", checkpointSchema);
