import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

export const activeRunStates = ["queued", "running", "waiting_approval"] as const;
export const taskRunStates = [...activeRunStates, "succeeded", "failed", "cancelled"] as const;

const taskRunSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    mode: { type: String, enum: ["plan", "build"], required: true, immutable: true },
    model: { type: String, required: true, maxlength: 160, immutable: true },
    prompt: { type: String, required: true, maxlength: 32 * 1024, immutable: true },
    baseRevisionId: { type: String, default: null, immutable: true },
    status: { type: String, enum: taskRunStates, required: true, default: "queued" },
    activeWorkspaceKey: { type: String, default: null },
    nextEventSequence: { type: Number, required: true, default: 0 },
    persistedEventBytes: { type: Number, required: true, default: 0 },
    cancelRequestedAt: { type: Date, default: null },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    failureCode: { type: String, default: null },
    budget: {
      maxModelTurns: { type: Number, required: true, default: 12 },
      maxToolCalls: { type: Number, required: true, default: 20 },
      maxWallTimeMs: { type: Number, required: true, default: 600_000 },
      maxPersistedEventBytes: { type: Number, required: true, default: 64 * 1024 },
    },
  },
  { strict: "throw", timestamps: true },
);

taskRunSchema.index({ workspaceId: 1, createdAt: -1 });
taskRunSchema.index({ activeWorkspaceKey: 1 }, { unique: true, sparse: true });
taskRunSchema.index({ leaseExpiresAt: 1 });

export type TaskRunRecord = InferSchemaType<typeof taskRunSchema>;
export const TaskRunModel = (models.ZmzaiAgentTaskRun as Model<TaskRunRecord> | undefined) ?? model<TaskRunRecord>("ZmzaiAgentTaskRun", taskRunSchema);
