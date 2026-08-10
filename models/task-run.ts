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
    // Continuation chain: this run continues the conversation of parentRunId.
    // Runs in the same conversation share the same AgentSession sessionId.
    parentRunId: { type: String, default: null, immutable: true },
    status: { type: String, enum: taskRunStates, required: true, default: "queued" },
    // Written when the run acquires its execution lease; terminal states write
    // finishedAt. waiting_approval intentionally keeps finishedAt unset so the
    // audit page can show a running elapsed duration.
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    // The field exists only while this Workspace has an active run. Omitting it
    // lets the partial unique index release the lock on terminal states.
    activeWorkspaceKey: { type: String },
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
// Cross-Workspace audit list is anchored on userId and sorted by createdAt desc.
taskRunSchema.index({ userId: 1, createdAt: -1 });
taskRunSchema.index(
  { activeWorkspaceKey: 1 },
  { unique: true, partialFilterExpression: { activeWorkspaceKey: { $type: "string" } } },
);
taskRunSchema.index({ leaseExpiresAt: 1 });

export type TaskRunRecord = InferSchemaType<typeof taskRunSchema>;
export const TaskRunModel = (models.ZmzaiAgentTaskRun as Model<TaskRunRecord> | undefined) ?? model<TaskRunRecord>("ZmzaiAgentTaskRun", taskRunSchema);
