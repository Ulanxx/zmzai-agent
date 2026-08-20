import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const automationSchema = new Schema(
  {
    automationId: { type: String, required: true, unique: true, immutable: true },
    userId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    goal: { type: String, required: true, maxlength: 32 * 1024 },
    schedule: { type: String, default: "手动运行", maxlength: 120 },
    timezone: { type: String, default: "Asia/Shanghai", maxlength: 64 },
    status: { type: String, enum: ["active", "paused"], default: "active" },
    lastRunAt: { type: Date, default: null },
    nextRunAt: { type: Date, default: null, index: true },
    lastRunStatus: { type: String, enum: ["idle", "running", "succeeded", "failed"], default: "idle" },
    lastError: { type: String, default: null, maxlength: 2_000 },
    lastRunTaskId: { type: String, default: null },
    lastRunId: { type: String, default: null },
    schedulerLeaseOwner: { type: String, default: null },
    schedulerLeaseExpiresAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

automationSchema.index({ userId: 1, updatedAt: -1 });
automationSchema.index({ status: 1, nextRunAt: 1, schedulerLeaseExpiresAt: 1 });
export type AutomationRecord = InferSchemaType<typeof automationSchema>;
export const AutomationModel = (models.ZmzaiAgentAutomation as Model<AutomationRecord> | undefined) ?? model<AutomationRecord>("ZmzaiAgentAutomation", automationSchema);
