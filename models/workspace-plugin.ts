import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

/** A pinned Agent Plugins 1.0 package owned by one Workspace. It is an
 * import record, never an executable installation: MCP authorization stays
 * in the connector control plane. */
const workspacePluginSchema = new Schema(
  {
    pluginId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    userId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, immutable: true, maxlength: 64 },
    version: { type: String, default: "", immutable: true, maxlength: 128 },
    description: { type: String, required: true, default: "", immutable: true, maxlength: 2_000 },
    repository: { type: String, required: true, immutable: true, match: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ },
    requestedRef: { type: String, required: true, immutable: true, maxlength: 256 },
    commitSha: { type: String, required: true, immutable: true, match: /^[0-9a-f]{40}$/ },
    path: { type: String, required: true, immutable: true, maxlength: 512 },
    skills: { type: [{ id: String, path: String, markdown: String }], required: true, default: [] },
    mcpServers: { type: Schema.Types.Mixed, required: true, default: {} },
    errors: { type: [String], required: true, default: [] },
  },
  { strict: "throw", timestamps: true, suppressReservedKeysWarning: true },
);

workspacePluginSchema.index({ workspaceId: 1, repository: 1, commitSha: 1, path: 1 }, { unique: true });

export type WorkspacePluginRecord = InferSchemaType<typeof workspacePluginSchema>;
export const WorkspacePluginModel =
  (models.ZmzaiWorkspacePlugin as Model<WorkspacePluginRecord> | undefined) ?? model<WorkspacePluginRecord>("ZmzaiWorkspacePlugin", workspacePluginSchema);
