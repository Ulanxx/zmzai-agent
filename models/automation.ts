import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const automationSchema = new Schema(
  {
    automationId: { type: String, required: true, unique: true, immutable: true },
    userId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    goal: { type: String, required: true, maxlength: 32 * 1024 },
    schedule: { type: String, default: "手动运行", maxlength: 120 },
    status: { type: String, enum: ["active", "paused"], default: "active" },
    lastRunAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

automationSchema.index({ userId: 1, updatedAt: -1 });
export type AutomationRecord = InferSchemaType<typeof automationSchema>;
export const AutomationModel = (models.ZmzaiAgentAutomation as Model<AutomationRecord> | undefined) ?? model<AutomationRecord>("ZmzaiAgentAutomation", automationSchema);
