import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const workspaceFileSchema = new Schema(
  {
    workspaceId: { type: String, required: true, immutable: true },
    path: { type: String, required: true, immutable: true, maxlength: 512 },
    content: { type: String, required: true, maxlength: 512 * 1024 },
    revisionId: { type: String, default: null },
  },
  { strict: "throw", timestamps: true },
);

workspaceFileSchema.index({ workspaceId: 1, path: 1 }, { unique: true });

export type WorkspaceFileRecord = InferSchemaType<typeof workspaceFileSchema>;
export const WorkspaceFileModel = (models.ZmzaiAgentWorkspaceFile as Model<WorkspaceFileRecord> | undefined) ?? model<WorkspaceFileRecord>("ZmzaiAgentWorkspaceFile", workspaceFileSchema);
