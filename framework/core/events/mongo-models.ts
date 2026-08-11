import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const frameworkEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    seq: { type: Number, required: true, immutable: true },
    type: { type: String, required: true, maxlength: 96, immutable: true },
    data: { type: Schema.Types.Mixed, required: true, immutable: true },
    at: { type: Date, required: true, immutable: true },
  },
  { strict: "throw", timestamps: false },
);

frameworkEventSchema.index({ sessionId: 1, seq: 1 }, { unique: true });

export type FrameworkEventRecord = InferSchemaType<typeof frameworkEventSchema>;
export const FrameworkEventModel =
  (models.ZmzaiFrameworkEvent as Model<FrameworkEventRecord> | undefined) ?? model<FrameworkEventRecord>("ZmzaiFrameworkEvent", frameworkEventSchema);

/** Per-session atomic sequence counter for event ordering. */
const frameworkSeqSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, immutable: true },
    seq: { type: Number, required: true },
  },
  { strict: "throw", timestamps: false },
);

export type FrameworkSeqRecord = InferSchemaType<typeof frameworkSeqSchema>;
export const FrameworkSeqModel =
  (models.ZmzaiFrameworkSeq as Model<FrameworkSeqRecord> | undefined) ?? model<FrameworkSeqRecord>("ZmzaiFrameworkSeq", frameworkSeqSchema);
