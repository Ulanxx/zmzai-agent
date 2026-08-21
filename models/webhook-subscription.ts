import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const webhookSubscriptionSchema = new Schema(
  {
    subscriptionId: { type: String, required: true, unique: true, immutable: true },
    userId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    url: { type: String, required: true, maxlength: 2_000 },
    events: { type: [String], required: true, default: [] },
    status: { type: String, enum: ["active", "paused"], required: true, default: "active" },
    encryptedSecret: { type: String, required: true, select: false, immutable: true },
    secretPrefix: { type: String, required: true, immutable: true, maxlength: 24 },
    lastDeliveredAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 2_000 },
  },
  { strict: "throw", timestamps: true },
);

webhookSubscriptionSchema.index({ userId: 1, workspaceId: 1, createdAt: -1 });
export type WebhookSubscriptionRecord = InferSchemaType<typeof webhookSubscriptionSchema>;
export const WebhookSubscriptionModel =
  (models.ZmzaiWebhookSubscription as Model<WebhookSubscriptionRecord> | undefined) ??
  model<WebhookSubscriptionRecord>("ZmzaiWebhookSubscription", webhookSubscriptionSchema);
