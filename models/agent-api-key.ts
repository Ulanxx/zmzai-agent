import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const agentApiKeySchema = new Schema(
  {
    agentApiKeyId: { type: String, required: true, unique: true, immutable: true },
    userId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    keyHash: { type: String, required: true, select: false, immutable: true },
    prefix: { type: String, required: true, immutable: true, maxlength: 24 },
    workspaceIds: { type: [String], required: true, immutable: true, default: [] },
    scopes: { type: [String], required: true, immutable: true, default: [] },
    status: { type: String, enum: ["active", "revoked"], required: true, default: "active" },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: true },
);

agentApiKeySchema.index({ keyHash: 1 }, { unique: true });
agentApiKeySchema.index({ userId: 1, createdAt: -1 });

export type AgentApiKeyRecord = InferSchemaType<typeof agentApiKeySchema>;
export const AgentApiKeyModel =
  (models.ZmzaiAgentApiKey as Model<AgentApiKeyRecord> | undefined) ??
  model<AgentApiKeyRecord>("ZmzaiAgentApiKey", agentApiKeySchema);
