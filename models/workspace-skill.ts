import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

/** An immutable, workspace-owned copy of a GitHub SKILL.md. The resolved
 * commit SHA is the version boundary used by AgentVersion capabilities. */
const workspaceSkillSchema = new Schema(
  {
    skillId: { type: String, required: true, unique: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true, index: true },
    userId: { type: String, required: true, immutable: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 128 },
    description: { type: String, required: true, default: "", maxlength: 2_000 },
    repository: { type: String, required: true, immutable: true, match: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ },
    requestedRef: { type: String, required: true, immutable: true, maxlength: 256 },
    commitSha: { type: String, required: true, immutable: true, match: /^[0-9a-f]{40}$/ },
    path: { type: String, required: true, immutable: true, maxlength: 512 },
    markdown: { type: String, required: true, immutable: true, maxlength: 256 * 1024 },
  },
  { strict: "throw", timestamps: true },
);

workspaceSkillSchema.index({ workspaceId: 1, repository: 1, commitSha: 1, path: 1 }, { unique: true });

export type WorkspaceSkillRecord = InferSchemaType<typeof workspaceSkillSchema>;
export const WorkspaceSkillModel =
  (models.ZmzaiWorkspaceSkill as Model<WorkspaceSkillRecord> | undefined) ?? model<WorkspaceSkillRecord>("ZmzaiWorkspaceSkill", workspaceSkillSchema);
