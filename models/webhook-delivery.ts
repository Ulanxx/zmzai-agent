import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const webhookDeliverySchema = new Schema(
  {
    deliveryId: { type: String, required: true, unique: true, immutable: true },
    subscriptionId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    eventType: { type: String, required: true, immutable: true, maxlength: 80 },
    taskId: { type: String, required: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    payload: { type: Schema.Types.Mixed, required: true, immutable: true },
    status: { type: String, enum: ["pending", "delivering", "delivered", "failed"], required: true, default: "pending" },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    nextAttemptAt: { type: Date, required: true, default: Date.now, index: true },
    leaseExpiresAt: { type: Date, default: null },
    responseStatus: { type: Number, default: null },
    lastError: { type: String, default: null, maxlength: 2_000 },
    deliveredAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

webhookDeliverySchema.index({ subscriptionId: 1, taskId: 1, runId: 1, eventType: 1 }, { unique: true });
webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1, leaseExpiresAt: 1 });
export type WebhookDeliveryRecord = InferSchemaType<typeof webhookDeliverySchema>;
export const WebhookDeliveryModel =
  (models.ZmzaiWebhookDelivery as Model<WebhookDeliveryRecord> | undefined) ??
  model<WebhookDeliveryRecord>("ZmzaiWebhookDelivery", webhookDeliverySchema);
