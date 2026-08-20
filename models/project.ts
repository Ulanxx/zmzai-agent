import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const projectSchema = new Schema(
  {
    projectId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    userId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, default: "", maxlength: 4_000 },
    instructions: { type: String, default: "", maxlength: 64 * 1024 },
  },
  { strict: "throw", timestamps: true },
);

projectSchema.index({ userId: 1, workspaceId: 1, name: 1 }, { unique: true });
projectSchema.index({ userId: 1, updatedAt: -1 });

export type ProjectRecord = InferSchemaType<typeof projectSchema>;
export const ProjectModel = (models.ZmzaiAgentProject as Model<ProjectRecord> | undefined) ?? model<ProjectRecord>("ZmzaiAgentProject", projectSchema);
