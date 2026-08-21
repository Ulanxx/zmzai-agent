import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const productMetricEventSchema = new Schema(
  {
    kind: { type: String, required: true, enum: ["artifact_downloaded", "task_followed_up"] },
    userId: { type: String, required: true, immutable: true },
    taskId: { type: String, default: null, immutable: true },
    runId: { type: String, default: null, immutable: true },
    artifactId: { type: String, default: null, immutable: true },
  },
  { strict: "throw", timestamps: true },
);

productMetricEventSchema.index({ kind: 1, createdAt: -1 });
productMetricEventSchema.index({ userId: 1, kind: 1, createdAt: -1 });

export type ProductMetricEventRecord = InferSchemaType<typeof productMetricEventSchema>;
export const ProductMetricEventModel =
  (models.ZmzaiAgentProductMetricEvent as Model<ProductMetricEventRecord> | undefined) ??
  model<ProductMetricEventRecord>("ZmzaiAgentProductMetricEvent", productMetricEventSchema);
