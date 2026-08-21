import { randomUUID } from "node:crypto";

import { createFrameworkSession, defaultStore } from "@/framework/core/runtime/runner";
import { getFrameworkRunner } from "@/framework/server/context";
import { finalAssistantText } from "@/lib/structured-output";
import { createRunForTask, createTaskForSession, releaseRunBudget, reserveRunBudget, cancelRunForSession } from "@/lib/task-run-control";
import { RunModel } from "@/models/run";
import { SubagentRunModel } from "@/models/subagent-run";
import { TaskModel } from "@/models/task";
import { WideResearchJobModel } from "@/models/wide-research-job";
import { createMongoWorkspaceFiles } from "@/framework/core/tools/mongo-workspace";
import type { Ruleset } from "@/framework/core/runtime/runner";

const maxPromptChars = 16 * 1024;
const maxSynthesisChars = 96 * 1024;

function id(prefix: string) { return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`; }

export const researchRoles = ["资料检索", "事实核验", "反方审查", "行业视角", "数据整理", "趋势分析", "案例比较", "风险评估"] as const;

// Research workers are autonomous by design, but their tool surface remains
// read-only. Python is allowed only as a sandbox calculation aid for CSV and
// other uploaded text; write/edit and arbitrary shell commands still prompt.
const researchWorkerPermission: Ruleset = [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "list", pattern: "*", action: "allow" },
  { permission: "todo", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "python3 *", action: "allow" },
  { permission: "bash", pattern: "python *", action: "allow" },
  { permission: "bash", pattern: "awk *", action: "allow" },
];

async function waitForRun(sessionId: string, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await RunModel.findOne({ sessionId }).sort({ createdAt: -1 }).lean();
    if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return await RunModel.findOne({ sessionId }).sort({ createdAt: -1 }).lean();
}

async function runChild(jobId: string, index: number): Promise<void> {
  const job = await WideResearchJobModel.findOne({ researchJobId: jobId }).lean();
  if (!job) return;
  const child = job.children[index];
  if (!child || child.status === "succeeded" || child.status === "failed") return;
  await WideResearchJobModel.updateOne({ researchJobId: jobId, [`children.${index}.status`]: { $in: ["queued", "running"] } }, { $set: { [`children.${index}.status`]: "running", [`children.${index}.startedAt`]: child.startedAt ?? new Date() } });
  await SubagentRunModel.updateOne({ childSessionId: child.childSessionId }, { $set: { status: "running", startedAt: new Date() } });
  let budgetReserved = false;
  try {
    const childRun = await RunModel.findOne({ runId: child.childRunId }).lean();
    budgetReserved = Boolean(childRun?.budgetReserved);
    if (!budgetReserved) budgetReserved = await reserveRunBudget(child.childRunId);
    await getFrameworkRunner().prompt(child.childSessionId, { text: child.prompt, agent: "explore" });
    const run = await waitForRun(child.childSessionId);
    const text = run?.status === "succeeded" ? finalAssistantText(await defaultStore.getMessages(child.childSessionId)) : null;
    if (!run || run.status !== "succeeded") throw new Error("研究子任务执行失败");
    await WideResearchJobModel.updateOne({ researchJobId: jobId }, { $set: { [`children.${index}.status`]: "succeeded", [`children.${index}.summary`]: text?.slice(0, 16 * 1024) ?? "", [`children.${index}.finishedAt`]: new Date() } });
    await SubagentRunModel.updateOne({ childSessionId: child.childSessionId }, { $set: { status: "completed", summary: text?.slice(0, 8 * 1024) ?? "", finishedAt: new Date() } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "研究子任务失败";
    await WideResearchJobModel.updateOne({ researchJobId: jobId }, { $set: { [`children.${index}.status`]: "failed", [`children.${index}.error`]: message, [`children.${index}.finishedAt`]: new Date() }, $inc: { failedChildren: 1 } });
    await SubagentRunModel.updateOne({ childSessionId: child.childSessionId }, { $set: { status: "failed", error: message, finishedAt: new Date() } });
    await cancelRunForSession(child.childSessionId, message).catch(() => undefined);
    if (budgetReserved) await releaseRunBudget(child.childRunId).catch(() => undefined);
  }
}

export async function runWideResearch(jobId: string): Promise<void> {
  const owner = id("research-worker");
  const now = new Date();
  const job = await WideResearchJobModel.findOneAndUpdate(
    { researchJobId: jobId, status: { $in: ["queued", "running"] }, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] },
    { $set: { status: "running", leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + 15 * 60_000) } },
    { new: true },
  ).lean();
  if (!job) return;
  for (let cursor = 0; cursor < job.children.length; cursor += job.maxConcurrency) {
    await Promise.all(Array.from({ length: Math.min(job.maxConcurrency, job.children.length - cursor) }, (_, offset) => runChild(jobId, cursor + offset)));
  }
  const completed = await WideResearchJobModel.findOne({ researchJobId: jobId }).lean();
  if (!completed) return;
  if (completed.synthesisStatus === "succeeded") {
    await WideResearchJobModel.updateOne({ researchJobId: jobId, leaseOwner: owner }, { $set: { status: "succeeded", leaseOwner: null, leaseExpiresAt: null } });
    return;
  }
  const synthesis = await WideResearchJobModel.findOneAndUpdate(
    { researchJobId: jobId, leaseOwner: owner, synthesisStatus: { $in: ["queued", "running", null] } },
    { $set: { synthesisStatus: "running", synthesisStartedAt: new Date() } },
    { new: true },
  ).lean();
  if (!synthesis) return;
  const parentRun = await RunModel.findOne({ runId: completed.parentRunId }).lean();
  if (parentRun?.status === "succeeded") {
    await WideResearchJobModel.updateOne({ researchJobId: jobId, leaseOwner: owner }, { $set: { status: "succeeded", synthesisStatus: "succeeded", synthesisFinishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
    return;
  }
  const evidence = completed.children.map((child) => `## ${child.role}\n状态: ${child.status}\n${child.summary ?? child.error ?? "无结果"}`).join("\n\n").slice(0, maxSynthesisChars);
  const synthesisPrompt = `你负责综合一项广泛研究。原始问题：\n${completed.question}\n\n以下是多个独立研究角色的结果，请去重、标注不确定性、指出冲突，并给出结构清晰的最终结论。\n\n${evidence}`;
  try {
    await getFrameworkRunner().prompt(completed.parentSessionId, { text: synthesisPrompt });
    const run = await waitForRun(completed.parentSessionId);
    await WideResearchJobModel.updateOne({ researchJobId: jobId, leaseOwner: owner }, { $set: { status: run?.status === "succeeded" ? "succeeded" : "failed", synthesisStatus: run?.status === "succeeded" ? "succeeded" : "failed", synthesisFinishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, ...(run?.status !== "succeeded" ? { error: "综合任务执行失败" } : {}) } });
    await TaskModel.updateOne({ taskId: completed.parentTaskId }, { $set: { source: "research" } });
  } catch (error) {
    await WideResearchJobModel.updateOne({ researchJobId: jobId, leaseOwner: owner }, { $set: { status: "failed", synthesisStatus: "failed", synthesisFinishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, error: error instanceof Error ? error.message.slice(0, 2_000) : "研究综合失败" } });
  }
}

export async function dispatchDueWideResearch(input: { limit?: number } = {}) {
  const jobs = await WideResearchJobModel.find({ status: { $in: ["queued", "running"] }, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: new Date() } }] }).sort({ createdAt: 1 }).limit(input.limit ?? 4).select({ researchJobId: 1 }).lean();
  await Promise.all(jobs.map((job) => runWideResearch(job.researchJobId).catch((error) => console.error("wide research tick", error))));
  return { claimed: jobs.length };
}

export async function createWideResearch(input: { userId: string; workspaceId: string; projectId?: string | null; question: string; roles: string[]; maxConcurrency: number; sessionId: string; files?: Array<{ path: string; content: string }> }) {
  const workspace = await import("@/lib/workspaces").then(({ getWorkspace }) => getWorkspace(input.userId, input.workspaceId));
  if (!workspace) throw new Error("Workspace 不存在");
  const session = await createFrameworkSession({ store: defaultStore, id: input.sessionId, userId: input.userId, workspaceId: input.workspaceId, agent: workspace.name, model: { providerId: "relay", modelId: workspace.defaultModel }, prompt: input.question, title: `广泛研究：${input.question.slice(0, 60)}`, permission: researchWorkerPermission });
    for (const file of input.files ?? []) {
      await createMongoWorkspaceFiles({ userId: input.userId, workspaceId: input.workspaceId, sessionId: input.sessionId }).write({ path: file.path, content: file.content, author: "agent", summary: `研究资料 ${file.path}` });
    }
  const task = await createTaskForSession({ session, goal: input.question, title: `广泛研究：${input.question.slice(0, 60)}`, projectId: input.projectId ?? null, source: "research" });
  const run = await createRunForTask({ task, session });
  const children = input.roles.map((role) => ({ childTaskId: "", childRunId: "", childSessionId: id("ses"), role, prompt: `你是“${role}”研究员。围绕以下问题独立工作，给出事实、来源线索、推理过程和不确定性：\n${input.question}`.slice(0, maxPromptChars), status: "queued" as const, summary: null, error: null, startedAt: null, finishedAt: null }));
  for (const child of children) {
    const childSession = await createFrameworkSession({ store: defaultStore, id: child.childSessionId, userId: input.userId, workspaceId: input.workspaceId, parentId: session.id, agent: "explore", model: { providerId: "relay", modelId: workspace.defaultModel }, prompt: child.prompt, title: child.role, permission: researchWorkerPermission });
    for (const file of input.files ?? []) {
      await createMongoWorkspaceFiles({ userId: input.userId, workspaceId: input.workspaceId, sessionId: child.childSessionId }).write({ path: file.path, content: file.content, author: "agent", summary: `研究资料 ${file.path}` });
    }
    const childTask = await createTaskForSession({ session: childSession, goal: child.prompt, title: child.role, projectId: input.projectId ?? null, source: "research" });
    const childRun = await createRunForTask({ task: childTask, session: childSession, parentRunId: run.runId, reserveBudget: false });
    child.childTaskId = childTask.taskId; child.childRunId = childRun.runId;
    await SubagentRunModel.create({ subagentRunId: id("subrun"), taskId: task.taskId, parentRunId: run.runId, parentSessionId: session.id, childSessionId: childSession.id, userId: input.userId, workspaceId: input.workspaceId, agent: "explore", description: child.role, prompt: child.prompt, status: "queued" });
  }
  const job = await WideResearchJobModel.create({ researchJobId: id("research"), userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId ?? null, parentTaskId: task.taskId, parentRunId: run.runId, parentSessionId: session.id, question: input.question, roles: input.roles, maxConcurrency: input.maxConcurrency, children });
  return { job, task, run, session };
}
