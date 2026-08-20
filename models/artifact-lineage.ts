import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const artifactLineageSchema = new Schema(
  {
    lineageId: { type: String, required: true, unique: true, immutable: true },
    userId: { type: String, required: true, immutable: true, index: true },
    taskId: { type: String, required: true, immutable: true },
    path: { type: String, required: true, immutable: true, maxlength: 512 },
    nextVersion: { type: Number, required: true, min: 0, default: 0 },
  },
  { strict: "throw", timestamps: true },
);

artifactLineageSchema.index({ userId: 1, taskId: 1, path: 1 }, { unique: true });

export type ArtifactLineageRecord = InferSchemaType<typeof artifactLineageSchema>;
export const ArtifactLineageModel =
  (models.ZmzaiAgentArtifactLineage as Model<ArtifactLineageRecord> | undefined) ?? model<ArtifactLineageRecord>("ZmzaiAgentArtifactLineage", artifactLineageSchema);
