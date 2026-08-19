import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const taskSchema = new Schema(
  {
    taskId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    // Project is introduced after B0; null keeps the migration explicit.
    projectId: { type: String, default: null },
    userId: { type: String, required: true, immutable: true },
    title: { type: String, required: true, maxlength: 240 },
    goal: { type: String, required: true, maxlength: 32 * 1024 },
    status: { type: String, enum: ["draft", "active", "succeeded", "failed", "cancelled"], required: true, default: "draft" },
    activeRunId: { type: String, default: null },
    latestRunId: { type: String, default: null },
    version: { type: Number, required: true, min: 1, default: 1 },
  },
  { strict: "throw", timestamps: true },
);

taskSchema.index({ userId: 1, workspaceId: 1, updatedAt: -1 });
taskSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });

export type TaskRecord = InferSchemaType<typeof taskSchema>;
export const TaskModel = (models.ZmzaiAgentTask as Model<TaskRecord> | undefined) ?? model<TaskRecord>("ZmzaiAgentTask", taskSchema);
