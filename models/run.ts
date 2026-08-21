import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const runSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true, immutable: true },
    taskId: { type: String, required: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    parentRunId: { type: String, default: null, immutable: true },
    resumeCheckpointId: { type: String, default: null, immutable: true },
    status: { type: String, enum: ["created", "running", "waiting_input", "waiting_approval", "paused", "succeeded", "failed", "cancelled"], required: true, default: "created" },
    // Explicitly indexed so Mongo can enforce one non-terminal Run per Task.
    active: { type: Boolean, required: true, default: true },
    budgetReserved: { type: Boolean, required: true, default: false },
    workspaceBudgetReserved: { type: Boolean, required: true, default: false },
    attempt: { type: Number, required: true, min: 1, default: 1 },
    terminalReason: { type: String, default: null, maxlength: 2_000 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    latestCheckpointId: { type: String, default: null },
  },
  { strict: "throw", timestamps: true },
);

runSchema.index({ taskId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
runSchema.index({ taskId: 1, createdAt: -1 });
runSchema.index({ sessionId: 1, createdAt: -1 });
runSchema.index({ workspaceId: 1, userId: 1, createdAt: -1 });

export type RunRecord = InferSchemaType<typeof runSchema>;
export const RunModel = (models.ZmzaiAgentRun as Model<RunRecord> | undefined) ?? model<RunRecord>("ZmzaiAgentRun", runSchema);
