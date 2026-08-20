import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const automationExecutionSchema = new Schema(
  {
    executionId: { type: String, required: true, unique: true, immutable: true },
    automationId: { type: String, required: true, immutable: true, index: true },
    userId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true },
    taskId: { type: String, required: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    source: { type: String, enum: ["manual", "schedule", "webhook"], required: true },
    status: { type: String, enum: ["queued", "running", "succeeded", "failed", "cancelled"], required: true, default: "queued" },
    error: { type: String, default: null, maxlength: 2_000 },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

automationExecutionSchema.index({ automationId: 1, createdAt: -1 });
automationExecutionSchema.index({ userId: 1, createdAt: -1 });
automationExecutionSchema.index({ sessionId: 1 }, { unique: true });

export type AutomationExecutionRecord = InferSchemaType<typeof automationExecutionSchema>;
export const AutomationExecutionModel =
  (models.ZmzaiAgentAutomationExecution as Model<AutomationExecutionRecord> | undefined) ?? model<AutomationExecutionRecord>("ZmzaiAgentAutomationExecution", automationExecutionSchema);
