import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const rulesetSchema = new Schema(
  {
    permission: { type: String, required: true },
    pattern: { type: String, required: true },
    action: { type: String, required: true, enum: ["allow", "deny", "ask"] },
  },
  { _id: false },
);

const queuedPromptSchema = new Schema(
  {
    text: { type: String, required: true },
    agent: { type: String, required: false },
    enqueuedAt: { type: String, required: true },
  },
  { _id: false },
);

const frameworkSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    parentId: { type: String, required: false, immutable: true },
    title: { type: String, required: true },
    agent: { type: String, required: true },
    agentId: { type: String, required: false, immutable: true },
    agentVersionId: { type: String, required: false, immutable: true },
    model: {
      providerId: { type: String, required: true },
      modelId: { type: String, required: true },
    },
    permission: { type: [rulesetSchema], required: true, default: [] },
    queuedPrompts: { type: [queuedPromptSchema], required: true, default: [] },
    time: {
      created: { type: String, required: true, immutable: true },
      updated: { type: String, required: true },
      archived: { type: String, required: false },
    },
    // Runner lease (reuses the existing lease-recovery pattern).
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
  },
  { strict: "throw", timestamps: false },
);

frameworkSessionSchema.index({ userId: 1, workspaceId: 1, "time.updated": -1 });

export type FrameworkSessionRecord = InferSchemaType<typeof frameworkSessionSchema>;
export const FrameworkSessionModel =
  (models.ZmzaiFrameworkSession as Model<FrameworkSessionRecord> | undefined) ??
  model<FrameworkSessionRecord>("ZmzaiFrameworkSession", frameworkSessionSchema);

const frameworkMessageSchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    // Full wire MessageInfo minus duplication: role discriminates the shape.
    info: { type: Schema.Types.Mixed, required: true },
  },
  { strict: "throw", timestamps: false },
);

frameworkMessageSchema.index({ sessionId: 1 });

export type FrameworkMessageRecord = InferSchemaType<typeof frameworkMessageSchema>;
export const FrameworkMessageModel =
  (models.ZmzaiFrameworkMessage as Model<FrameworkMessageRecord> | undefined) ??
  model<FrameworkMessageRecord>("ZmzaiFrameworkMessage", frameworkMessageSchema);

const frameworkPartSchema = new Schema(
  {
    partId: { type: String, required: true, unique: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    messageId: { type: String, required: true, immutable: true },
    part: { type: Schema.Types.Mixed, required: true },
  },
  { strict: "throw", timestamps: false },
);

frameworkPartSchema.index({ sessionId: 1, messageId: 1 });

export type FrameworkPartRecord = InferSchemaType<typeof frameworkPartSchema>;
export const FrameworkPartModel =
  (models.ZmzaiFrameworkPart as Model<FrameworkPartRecord> | undefined) ?? model<FrameworkPartRecord>("ZmzaiFrameworkPart", frameworkPartSchema);
