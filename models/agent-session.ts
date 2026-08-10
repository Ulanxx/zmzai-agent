import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

export const agentSessionStates = ["active", "archived"] as const;

const agentSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, immutable: true },
    userId: { type: String, required: true, index: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    title: { type: String, required: true, maxlength: 180 },
    status: { type: String, enum: agentSessionStates, required: true, default: "active" },
    currentRunId: { type: String, default: null },
    lastRunId: { type: String, default: null },
  },
  { strict: "throw", timestamps: true },
);

agentSessionSchema.index({ userId: 1, workspaceId: 1, updatedAt: -1 });

export type AgentSessionRecord = InferSchemaType<typeof agentSessionSchema>;
export const AgentSessionModel = (models.ZmzaiAgentSession as Model<AgentSessionRecord> | undefined) ?? model<AgentSessionRecord>("ZmzaiAgentSession", agentSessionSchema);
