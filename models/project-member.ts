import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

const projectMemberSchema = new Schema(
  {
    memberId: { type: String, required: true, unique: true, immutable: true },
    projectId: { type: String, required: true, immutable: true, index: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    userId: { type: String, required: true, immutable: true, index: true },
    role: { type: String, enum: ["viewer", "member", "editor"], required: true, default: "member" },
    invitedBy: { type: String, required: true, immutable: true },
  },
  { strict: "throw", timestamps: true },
);

projectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true });

export type ProjectMemberRecord = InferSchemaType<typeof projectMemberSchema>;
export const ProjectMemberModel =
  (models.ZmzaiAgentProjectMember as Model<ProjectMemberRecord> | undefined) ??
  model<ProjectMemberRecord>("ZmzaiAgentProjectMember", projectMemberSchema);
