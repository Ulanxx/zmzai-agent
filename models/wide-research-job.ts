import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const childSchema = new Schema({
  childTaskId: { type: String, required: true },
  childRunId: { type: String, required: true },
  childSessionId: { type: String, required: true },
  role: { type: String, required: true, maxlength: 80 },
  prompt: { type: String, required: true, maxlength: 16 * 1024 },
  status: { type: String, enum: ["queued", "running", "succeeded", "failed"], required: true, default: "queued" },
  summary: { type: String, default: null, maxlength: 16 * 1024 },
  error: { type: String, default: null, maxlength: 2_000 },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { _id: false, strict: "throw" });

const wideResearchJobSchema = new Schema({
  researchJobId: { type: String, required: true, unique: true, immutable: true },
  userId: { type: String, required: true, immutable: true, index: true },
  workspaceId: { type: String, required: true, immutable: true, index: true },
  projectId: { type: String, default: null, immutable: true },
  parentTaskId: { type: String, required: true, immutable: true, index: true },
  parentRunId: { type: String, required: true, immutable: true },
  parentSessionId: { type: String, required: true, immutable: true },
  question: { type: String, required: true, maxlength: 32 * 1024 },
  roles: { type: [String], required: true, validate: (value: string[]) => value.length > 0 && value.length <= 8 },
  maxConcurrency: { type: Number, required: true, min: 1, max: 4 },
  status: { type: String, enum: ["queued", "running", "succeeded", "failed"], required: true, default: "queued" },
  synthesisStatus: { type: String, enum: ["queued", "running", "succeeded", "failed"], required: true, default: "queued" },
  synthesisStartedAt: { type: Date, default: null },
  synthesisFinishedAt: { type: Date, default: null },
  children: { type: [childSchema], required: true, default: [] },
  failedChildren: { type: Number, required: true, min: 0, default: 0 },
  error: { type: String, default: null, maxlength: 2_000 },
  leaseOwner: { type: String, default: null, maxlength: 120 },
  leaseExpiresAt: { type: Date, default: null, index: true },
}, { strict: "throw", timestamps: true });

wideResearchJobSchema.index({ userId: 1, createdAt: -1 });
export type WideResearchJobRecord = InferSchemaType<typeof wideResearchJobSchema>;
export const WideResearchJobModel = (models.ZmzaiWideResearchJob as Model<WideResearchJobRecord> | undefined) ?? model<WideResearchJobRecord>("ZmzaiWideResearchJob", wideResearchJobSchema);
