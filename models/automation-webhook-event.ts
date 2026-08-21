import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const automationWebhookEventSchema = new Schema(
  {
    automationId: { type: String, required: true, immutable: true, index: true },
    eventId: { type: String, required: true, immutable: true, maxlength: 160 },
    payloadHash: { type: String, required: true, immutable: true, maxlength: 64 },
    executionId: { type: String, required: true, immutable: true, index: true },
    // The event is claimed before the task starts; these projections are
    // filled in after launch succeeds and must remain mutable.
    sessionId: { type: String, default: null },
    taskId: { type: String, default: null },
    parentSessionId: { type: String, default: null },
    parentTaskId: { type: String, default: null },
    contextText: { type: String, default: null, maxlength: 200_000 },
    replyUrl: { type: String, default: null, maxlength: 2_048 },
    status: { type: String, enum: ["accepted", "failed"], required: true, default: "accepted" },
    dispatchStatus: { type: String, enum: ["pending", "processing", "launched", "failed"], required: true, default: "pending", index: true },
    dispatchLeaseOwner: { type: String, default: null },
    dispatchLeaseExpiresAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null, index: true },
    attemptCount: { type: Number, required: true, default: 0 },
    error: { type: String, default: null, maxlength: 2_000 },
  },
  { strict: "throw", timestamps: true },
);

automationWebhookEventSchema.index({ automationId: 1, eventId: 1 }, { unique: true });
automationWebhookEventSchema.index({ dispatchStatus: 1, nextAttemptAt: 1, dispatchLeaseExpiresAt: 1 });
export type AutomationWebhookEventRecord = InferSchemaType<typeof automationWebhookEventSchema>;
export const AutomationWebhookEventModel =
  (models.ZmzaiAgentAutomationWebhookEvent as Model<AutomationWebhookEventRecord> | undefined) ??
  model<AutomationWebhookEventRecord>("ZmzaiAgentAutomationWebhookEvent", automationWebhookEventSchema);
