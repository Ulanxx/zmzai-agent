import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

/** Product control-plane identity. Runtime configuration belongs to the
 *  immutable AgentVersion document, so historical sessions stay reproducible. */
const agentSchema = new Schema(
  {
    agentId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    userId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 64 },
    description: { type: String, required: true, default: "", maxlength: 2_000 },
    icon: { type: String, required: true, default: "spark", maxlength: 64 },
    /** Mutable control-plane draft. Sessions never read this directly: they
     *  pin an immutable AgentVersion at creation time. */
    draft: { type: Schema.Types.Mixed, default: null },
    publishedVersionId: { type: String, default: null },
  },
  { strict: "throw", timestamps: true },
);

agentSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export type AgentRecord = InferSchemaType<typeof agentSchema>;
export const AgentModel = (models.ZmzaiAgentDefinition as Model<AgentRecord> | undefined) ?? model<AgentRecord>("ZmzaiAgentDefinition", agentSchema);

const agentVersionSchema = new Schema(
  {
    agentVersionId: { type: String, required: true, unique: true, immutable: true },
    agentId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    version: { type: Number, required: true, immutable: true, min: 1 },
    /** Fully resolved AgentInfo at publish time. Plugin/connector references
     *  are stored as declarative IDs; secrets never appear in this document. */
    agent: { type: Schema.Types.Mixed, required: true },
    capabilities: {
      tools: { type: [String], required: true, default: [] },
      pluginIds: { type: [String], required: true, default: [] },
      skillIds: { type: [String], required: true, default: [] },
      connectorIds: { type: [String], required: true, default: [] },
    },
  },
  { strict: "throw", timestamps: true },
);

agentVersionSchema.index({ agentId: 1, version: -1 }, { unique: true });

export type AgentVersionRecord = InferSchemaType<typeof agentVersionSchema>;
export const AgentVersionModel =
  (models.ZmzaiAgentVersion as Model<AgentVersionRecord> | undefined) ?? model<AgentVersionRecord>("ZmzaiAgentVersion", agentVersionSchema);
