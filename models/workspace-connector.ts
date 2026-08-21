import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

/** Connector metadata is visible to Workspace users; credential material is
 * encrypted server-side and deliberately omitted from every API summary. */
const workspaceConnectorSchema = new Schema(
  {
    connectorId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    userId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 96 },
    transport: { type: String, required: true, enum: ["streamable-http", "sse", "github"] },
    url: { type: String, required: true, maxlength: 2_000 },
    encryptedHeaders: { type: String, required: true, select: false },
    status: { type: String, required: true, enum: ["untested", "ready", "error"], default: "untested" },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 1_000 },
  },
  { strict: "throw", timestamps: true },
);

workspaceConnectorSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export type WorkspaceConnectorRecord = InferSchemaType<typeof workspaceConnectorSchema>;
export const WorkspaceConnectorModel =
  (models.ZmzaiWorkspaceConnector as Model<WorkspaceConnectorRecord> | undefined) ?? model<WorkspaceConnectorRecord>("ZmzaiWorkspaceConnector", workspaceConnectorSchema);
