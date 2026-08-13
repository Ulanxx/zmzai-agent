import { model, models, Schema, type InferSchemaType, type Model } from "mongoose";

/** Workspace = 智能体（2026-08-13 重构）：Agent 配置合并进 Workspace。
 *  一个 Workspace 就是一个自定义智能体，其下所有任务（session）共用这套配置。 */
const workspaceSchema = new Schema(
  {
    workspaceId: { type: String, required: true, unique: true, immutable: true },
    userId: { type: String, required: true, index: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 2_000 },
    currentRevisionId: { type: String, default: null },
    defaultModel: { type: String, required: true, maxlength: 160 },
    approvalMode: { type: String, enum: ["always"], required: true, default: "always" },
    // —— Agent 配置（原 AgentModel/AgentVersion 字段搬入）——
    /** 系统提示词（AGENT.md）。 */
    prompt: { type: String, default: "", maxlength: 64 * 1024 },
    /** 最大模型轮次。 */
    steps: { type: Number, default: 12, min: 1, max: 64 },
    /** 允许使用的工具白名单（null = 内置全部）。 */
    tools: { type: [String], default: [] },
    /** 已启用的 workspace skill id 列表。 */
    skillIds: { type: [String], default: [] },
    /** 已启用的 workspace plugin id 列表。 */
    pluginIds: { type: [String], default: [] },
    /** 已启用的 workspace connector id 列表。 */
    connectorIds: { type: [String], default: [] },
    /** 会话级权限规则（allow/deny/ask，last-match-wins）。 */
    permission: {
      type: [{ permission: String, pattern: String, action: { type: String, enum: ["allow", "deny", "ask"] } }],
      default: [],
    },
  },
  { strict: "throw", timestamps: true },
);

workspaceSchema.index({ userId: 1, updatedAt: -1 });

export type WorkspaceRecord = InferSchemaType<typeof workspaceSchema>;
export const WorkspaceModel = (models.ZmzaiAgentWorkspace as Model<WorkspaceRecord> | undefined) ?? model<WorkspaceRecord>("ZmzaiAgentWorkspace", workspaceSchema);
