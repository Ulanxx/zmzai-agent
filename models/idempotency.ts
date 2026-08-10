import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const idempotencySchema = new Schema(
  {
    userId: { type: String, required: true, immutable: true },
    scope: { type: String, required: true, immutable: true, maxlength: 128 },
    key: { type: String, required: true, immutable: true, maxlength: 128 },
    requestHash: { type: String, required: true, immutable: true },
    resourceId: { type: String, required: true, immutable: true },
    expiresAt: { type: Date, required: true },
  },
  { strict: "throw", timestamps: true },
);

idempotencySchema.index({ userId: 1, scope: 1, key: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type IdempotencyRecord = InferSchemaType<typeof idempotencySchema>;
export const IdempotencyModel = (models.ZmzaiAgentIdempotency as Model<IdempotencyRecord> | undefined) ?? model<IdempotencyRecord>("ZmzaiAgentIdempotency", idempotencySchema);
