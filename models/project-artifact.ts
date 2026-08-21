import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const projectArtifactSchema = new Schema(
  {
    referenceId: { type: String, required: true, unique: true, immutable: true },
    projectId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    artifactId: { type: String, required: true, immutable: true, index: true },
    artifactOwnerId: { type: String, required: true, immutable: true },
    addedBy: { type: String, required: true, immutable: true },
  },
  { strict: "throw", timestamps: true },
);

projectArtifactSchema.index({ projectId: 1, artifactId: 1 }, { unique: true });

export type ProjectArtifactRecord = InferSchemaType<typeof projectArtifactSchema>;
export const ProjectArtifactModel =
  (models.ZmzaiAgentProjectArtifact as Model<ProjectArtifactRecord> | undefined) ??
  model<ProjectArtifactRecord>("ZmzaiAgentProjectArtifact", projectArtifactSchema);
