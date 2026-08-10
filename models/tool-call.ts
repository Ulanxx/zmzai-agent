import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

export const toolCallStates = ["requested", "running", "completed", "failed"] as const;

const summarySchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 4 * 1024 },
    truncated: { type: Boolean, required: true, default: false },
    omittedBytes: { type: Number, required: true, default: 0 },
  },
  { _id: false, strict: "throw" },
);

const toolCallSchema = new Schema(
  {
    toolCallId: { type: String, required: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    name: { type: String, required: true, maxlength: 96 },
    status: { type: String, enum: toolCallStates, required: true, default: "requested" },
    argsSummary: { type: String, required: true, maxlength: 4 * 1024 },
    label: { type: String, default: "", maxlength: 240 },
    resultSummary: { type: summarySchema, default: null },
    durationMs: { type: Number, default: null },
    requestedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

toolCallSchema.index({ userId: 1, runId: 1, requestedAt: 1 });
toolCallSchema.index({ runId: 1, toolCallId: 1 }, { unique: true });
toolCallSchema.index({ runId: 1, status: 1 });

export type ToolCallRecord = InferSchemaType<typeof toolCallSchema>;
export const ToolCallModel = (models.ZmzaiAgentToolCall as Model<ToolCallRecord> | undefined) ?? model<ToolCallRecord>("ZmzaiAgentToolCall", toolCallSchema);
