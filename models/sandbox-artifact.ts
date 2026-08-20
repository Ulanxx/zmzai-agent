import { model, models, Schema, type InferSchemaType, type Model, type Types } from "mongoose";

const sandboxArtifactSchema = new Schema(
  {
    artifactId: { type: String, required: true, unique: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true, index: true },
    toolCallId: { type: String, required: true, immutable: true },
    sandboxPath: { type: String, required: true, maxlength: 512 },
    title: { type: String, required: true, maxlength: 240, default: "" },
    tags: { type: [String], default: [] },
    versionGroupId: { type: String, default: null, immutable: true },
    version: { type: Number, default: 1, min: 1, immutable: true },
    contentType: { type: String, required: true, maxlength: 128 },
    sizeBytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true },
    // GridFS file id; null when the artifact was marked tooLarge and skipped.
    gridFsFileId: { type: Schema.Types.ObjectId, default: null },
    tooLarge: { type: Boolean, required: true, default: false },
    qualityStatus: { type: String, enum: ["not_applicable", "pending", "passed", "failed"], default: "not_applicable" },
    qualityResult: { type: Schema.Types.Mixed, default: null },
    shareTokenHash: { type: String, default: null, select: false },
    shareExpiresAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

sandboxArtifactSchema.index({ runId: 1, createdAt: 1 });
sandboxArtifactSchema.index({ userId: 1, artifactId: 1 });
sandboxArtifactSchema.index({ userId: 1, versionGroupId: 1, version: -1 });
sandboxArtifactSchema.index({ shareTokenHash: 1, shareExpiresAt: 1 });

export type SandboxArtifactRecord = InferSchemaType<typeof sandboxArtifactSchema> & { gridFsFileId: Types.ObjectId | null };
export const SandboxArtifactModel = (models.ZmzaiAgentSandboxArtifact as Model<SandboxArtifactRecord> | undefined) ?? model<SandboxArtifactRecord>("ZmzaiAgentSandboxArtifact", sandboxArtifactSchema);
