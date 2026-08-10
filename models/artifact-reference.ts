import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const artifactReferenceSchema = new Schema(
  {
    artifactId: { type: String, required: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    toolCallId: { type: String, default: null, immutable: true },
    kind: { type: String, required: true, maxlength: 96 },
    title: { type: String, required: true, maxlength: 240 },
    payload: { type: Schema.Types.Mixed, required: true },
    payloadBytes: { type: Number, required: true, default: 0 },
    truncated: { type: Boolean, required: true, default: false },
    omittedBytes: { type: Number, required: true, default: 0 },
  },
  { strict: "throw", timestamps: true },
);

artifactReferenceSchema.index({ userId: 1, runId: 1, createdAt: 1 });
artifactReferenceSchema.index({ runId: 1, artifactId: 1 }, { unique: true });
artifactReferenceSchema.index({ runId: 1, toolCallId: 1 });

export type ArtifactReferenceRecord = InferSchemaType<typeof artifactReferenceSchema>;
export const ArtifactReferenceModel = (models.ZmzaiAgentArtifactReference as Model<ArtifactReferenceRecord> | undefined) ?? model<ArtifactReferenceRecord>("ZmzaiAgentArtifactReference", artifactReferenceSchema);
