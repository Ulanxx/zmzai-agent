import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const revisionChangeSchema = new Schema(
  {
    path: { type: String, required: true, maxlength: 512 },
    operation: { type: String, enum: ["create", "update", "delete"], required: true },
    before: { type: String, default: null },
    after: { type: String, default: null },
  },
  { _id: false, strict: "throw" },
);

const workspaceRevisionSchema = new Schema(
  {
    revisionId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    // 会话级隔离：revision 链同样按会话划分（见 workspace-file.ts）。
    sessionId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, immutable: true },
    parentRevisionId: { type: String, default: null, immutable: true },
    author: { type: String, enum: ["user", "agent"], required: true, immutable: true },
    changes: { type: [revisionChangeSchema], required: true },
    summary: { type: String, required: true, maxlength: 2_000 },
  },
  { strict: "throw", timestamps: true },
);

workspaceRevisionSchema.index({ workspaceId: 1, createdAt: -1 });

export type WorkspaceRevisionRecord = InferSchemaType<typeof workspaceRevisionSchema>;
export const WorkspaceRevisionModel = (models.ZmzaiAgentWorkspaceRevision as Model<WorkspaceRevisionRecord> | undefined) ?? model<WorkspaceRevisionRecord>("ZmzaiAgentWorkspaceRevision", workspaceRevisionSchema);
