import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { IdempotencyError, claimIdempotency } from "@/lib/idempotency";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { addTaskWorkspaceSkill } from "@/lib/workspace-skills";
import { getWorkspace, updateWorkspace } from "@/lib/workspaces";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().trim().max(2_000).optional(),
}).strict();

function defaultSkillMarkdown(name: string, goal: string): string {
  return [
    `# ${name}`,
    "",
    "## Reusable task pattern",
    "Use this skill when the user requests work materially similar to the reference task below. First identify the inputs, constraints, and expected deliverable that are specific to the current request. Reuse the successful task pattern, but do not assume stale facts, files, or external state still apply.",
    "",
    "## Reference task",
    goal,
    "",
    "## Delivery standard",
    "Make the result directly usable, state important assumptions, and verify the final output before reporting completion.",
  ].join("\n");
}

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { taskId } = await context.params;
  const task = await TaskModel.findOne({ taskId }).lean();
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const access = task.projectId ? await getProjectAccess(task.projectId, user.id) : task.userId === user.id ? { role: "owner" as const } : null;
  if (!access) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  if (access.role !== "owner" && !canEditProject(access.role)) return apiError("FORBIDDEN", 403, "当前角色不能保存 Skill");
  if (task.status !== "succeeded") return apiError("TASK_NOT_COMPLETE", 409, "只有已完成任务可以保存为 Skill");
  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Skill 格式不正确");

  let claim;
  try {
    claim = await claimIdempotency({ userId: user.id, scope: "task.skill", key: request.headers.get("idempotency-key"), body: { taskId, ...parsed.data }, resourceId: `skl_${randomUUID().replaceAll("-", "").slice(0, 20)}` });
  } catch (error) {
    if (error instanceof IdempotencyError) return apiError(error.code, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? 400 : 409, error.code === "IDEMPOTENCY_KEY_REQUIRED" ? "Idempotency-Key 必须是 16 到 128 个可打印字符" : "同一 Idempotency-Key 不能对应不同请求");
    throw error;
  }

  const workspace = await getWorkspace(task.userId, task.workspaceId);
  if (!workspace) return apiError("WORKSPACE_NOT_FOUND", 404, "任务使用的 Workspace 不存在");
  const name = parsed.data.name ?? (task.title.trim().slice(0, 128) || "任务 Skill");
  const description = parsed.data.description ?? `来自已完成任务：${task.goal.trim().slice(0, 240)}`;
  const skill = await addTaskWorkspaceSkill({
    userId: task.userId,
    workspaceId: task.workspaceId,
    taskId: task.taskId,
    name,
    description,
    markdown: defaultSkillMarkdown(name, task.goal),
  });
  const skillIds = workspace.skillIds.includes(skill.skill.id) ? workspace.skillIds : [...workspace.skillIds, skill.skill.id];
  await updateWorkspace(task.userId, task.workspaceId, { skillIds });
  return NextResponse.json({ ...skill, enabled: true, replayed: claim.replayed }, { status: skill.reused ? 200 : 201, headers: { "cache-control": "no-store" } });
}
