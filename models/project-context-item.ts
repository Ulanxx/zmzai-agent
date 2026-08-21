import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const projectContextItemSchema = new Schema(
  {
    contextId: { type: String, required: true, unique: true, immutable: true },
    projectId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    userId: { type: String, required: true, immutable: true, index: true },
    type: { type: String, enum: ["note", "link"], required: true, immutable: true },
    title: { type: String, required: true, maxlength: 160 },
    content: { type: String, default: "", maxlength: 64 * 1024 },
    url: { type: String, default: "", maxlength: 2_000 },
    enabled: { type: Boolean, required: true, default: true },
  },
  { strict: "throw", timestamps: true },
);

projectContextItemSchema.index({ projectId: 1, createdAt: -1 });

export type ProjectContextItemRecord = InferSchemaType<typeof projectContextItemSchema>;
export const ProjectContextItemModel =
  (models.ZmzaiAgentProjectContextItem as Model<ProjectContextItemRecord> | undefined) ?? model<ProjectContextItemRecord>("ZmzaiAgentProjectContextItem", projectContextItemSchema);
