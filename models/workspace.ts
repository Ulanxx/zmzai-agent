import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const workspaceSchema = new Schema(
  {
    workspaceId: { type: String, required: true, unique: true, immutable: true },
    userId: { type: String, required: true, index: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 2_000 },
    currentRevisionId: { type: String, default: null },
    defaultModel: { type: String, required: true, maxlength: 160 },
    approvalMode: { type: String, enum: ["always"], required: true, default: "always" },
    defaultAgentId: { type: String, default: null },
  },
  { strict: "throw", timestamps: true },
);

workspaceSchema.index({ userId: 1, updatedAt: -1 });

export type WorkspaceRecord = InferSchemaType<typeof workspaceSchema>;
export const WorkspaceModel = (models.ZmzaiAgentWorkspace as Model<WorkspaceRecord> | undefined) ?? model<WorkspaceRecord>("ZmzaiAgentWorkspace", workspaceSchema);
