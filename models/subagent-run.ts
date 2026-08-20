import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const subagentRunSchema = new Schema(
  {
    subagentRunId: { type: String, required: true, unique: true, immutable: true },
    parentSubagentRunId: { type: String, default: null, immutable: true },
    taskId: { type: String, required: true, immutable: true, index: true },
    parentRunId: { type: String, required: true, immutable: true },
    parentSessionId: { type: String, required: true, immutable: true },
    childSessionId: { type: String, required: true, immutable: true, unique: true },
    userId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true },
    agent: { type: String, required: true, maxlength: 64 },
    description: { type: String, required: true, maxlength: 240 },
    prompt: { type: String, required: true, maxlength: 8 * 1024 },
    status: { type: String, enum: ["queued", "running", "completed", "failed", "cancelled"], default: "queued" },
    summary: { type: String, default: null, maxlength: 8 * 1024 },
    error: { type: String, default: null, maxlength: 2_000 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

subagentRunSchema.index({ taskId: 1, createdAt: -1 });
subagentRunSchema.index({ parentRunId: 1, createdAt: -1 });

export type SubagentRunRecord = InferSchemaType<typeof subagentRunSchema>;
export const SubagentRunModel =
  (models.ZmzaiAgentSubagentRun as Model<SubagentRunRecord> | undefined) ?? model<SubagentRunRecord>("ZmzaiAgentSubagentRun", subagentRunSchema);
