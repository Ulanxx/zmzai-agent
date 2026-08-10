import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { appendTaskEvent } from "@/lib/task-events";
import { createBuildTools } from "@/lib/build-tool-broker";
import { createExecTools } from "@/lib/exec-tool-broker";
import { hasPendingExecutions, getExecutionProposal } from "@/lib/execution-proposals";
import { resumeApprovedExecution } from "@/lib/execution-resume";
import { hasPendingProposals } from "@/lib/proposals";
import { createRelayModel, createRelayStreamFunction } from "@/lib/relay-agent-stream";
import { createReadOnlyTools } from "@/lib/read-only-tool-broker";
import { presentAgentEvent } from "@/lib/task-event-presentation";
import { TaskRunModel } from "@/models/task-run";
import { WorkspaceModel } from "@/models/workspace";

const runningAgents = globalThis as typeof globalThis & { __zmzaiAgentRuntime?: Map<string, Agent> };
const agents = runningAgents.__zmzaiAgentRuntime ?? new Map<string, Agent>();
runningAgents.__zmzaiAgentRuntime = agents;

const leaseDurationMs = 10 * 60 * 1000;

type RuntimeRun = {
  runId: string;
  userId: string;
  workspaceId: string;
  mode: "plan" | "build";
  model: string;
  prompt: string;
  baseRevisionId?: string | null;
  budget?: { maxModelTurns?: number } | null;
};

function systemPromptFor(mode: "plan" | "build"): string {
  return mode === "build"
    ? "你是 ZMZAI Agent。可使用已注册的读取工具分析当前 Workspace，也可通过 write 或 edit 生成待审批的文件变更提案。要运行代码或命令时使用 exec 生成执行提案，经用户批准后命令会在隔离沙箱中运行（基于含未批准变更的影子快照），输出会返回给你。提案不会立即修改 Workspace；不能声称已提交、执行或批准任何变更。用中文给出简洁、可核实的结果。"
    : "你是 ZMZAI Agent。仅使用已注册工具读取当前 Workspace；不能声称执行了未调用的操作。用中文给出简洁、可核实的结果。";
}

/**
 * Applies the shared terminal/approval decision after an agent turn settles.
 * - Pending proposals (build mode) -> waiting_approval; the Agent instance is
 *   kept alive in the runtime map so approval can resume it in place.
 * - Otherwise -> succeeded/failed and the Agent instance is released.
 */
async function settleRun(agent: Agent, run: RuntimeRun): Promise<void> {
  const failed = agent.state.errorMessage;
  const waitingApproval = !failed && run.mode === "build" && (await hasPendingProposals(run.runId) || await hasPendingExecutions(run.runId));
  if (waitingApproval) {
    const finalized = await TaskRunModel.findOneAndUpdate(
      { userId: run.userId, runId: run.runId, status: "running" },
      { $set: { status: "waiting_approval", activeWorkspaceKey: run.workspaceId, leaseOwner: null, leaseExpiresAt: null, failureCode: null } },
      { new: true },
    ).lean();
    if (finalized) await appendTaskEvent({ runId: run.runId, userId: run.userId, type: "run.waiting_approval", data: {} });
    return;
  }
  agents.delete(run.runId);
  const terminalUpdate = failed
    ? { $set: { status: "failed", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, failureCode: "RELAY_OR_AGENT_FAILED" }, $unset: { activeWorkspaceKey: 1 } }
    : { $set: { status: "succeeded", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, failureCode: null }, $unset: { activeWorkspaceKey: 1 } };
  const finalized = await TaskRunModel.findOneAndUpdate(
    { userId: run.userId, runId: run.runId, status: "running" },
    terminalUpdate,
    { new: true },
  ).lean();
  if (finalized) await appendTaskEvent({ runId: run.runId, userId: run.userId, type: failed ? "run.failed" : "run.completed", data: failed ? { code: "RELAY_OR_AGENT_FAILED", error: failed } : {} });
}

async function failActiveRun(input: { userId: string; runId: string; code: string; error: string }): Promise<void> {
  agents.delete(input.runId);
  const failedRun = await TaskRunModel.findOneAndUpdate(
    { userId: input.userId, runId: input.runId, status: { $in: ["running", "queued"] } },
    { $set: { status: "failed", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, failureCode: input.code }, $unset: { activeWorkspaceKey: 1 } },
    { new: true },
  ).lean();
  if (failedRun) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.failed", data: { code: input.code, error: input.error } });
}

export async function runAgentTask(input: { userId: string; runId: string; continuationMessages?: AgentMessage[] }): Promise<void> {
  const run = await TaskRunModel.findOneAndUpdate(
    { userId: input.userId, runId: input.runId, status: "queued" },
    { $set: { status: "running", startedAt: new Date(), leaseOwner: `node:${process.pid}`, leaseExpiresAt: new Date(Date.now() + leaseDurationMs) } },
    { new: true },
  ).lean();
  if (!run) return;

  const workspace = await WorkspaceModel.exists({ workspaceId: run.workspaceId, userId: input.userId });
  if (!workspace) {
    await failActiveRun({ userId: input.userId, runId: input.runId, code: "WORKSPACE_NOT_FOUND", error: "Workspace 不存在或不可访问" });
    return;
  }

  await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.started", data: { mode: run.mode, model: run.model } });
  const buildMode = run.mode === "build";
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPromptFor(run.mode),
      messages: input.continuationMessages ?? [],
      model: createRelayModel(run.model),
      tools: buildMode
        ? [...createBuildTools({ userId: input.userId, workspaceId: run.workspaceId, runId: input.runId, baseRevisionId: run.baseRevisionId ?? null }), ...createExecTools({ userId: input.userId, workspaceId: run.workspaceId, runId: input.runId })]
        : createReadOnlyTools({ userId: input.userId, workspaceId: run.workspaceId }),
    },
    streamFn: createRelayStreamFunction({ userId: input.userId, taskRunId: input.runId }),
    toolExecution: "sequential",
    shouldStopAfterTurn: ({ newMessages }) => newMessages.filter((message) => message.role === "assistant").length >= (run.budget?.maxModelTurns ?? 12),
  });
  agents.set(input.runId, agent);
  const toolStartedAt = new Map<string, number>();
  agent.subscribe(async (event) => {
    for (const visible of presentAgentEvent(event, toolStartedAt)) {
      await appendTaskEvent({ runId: input.runId, userId: input.userId, ...visible });
    }
  });

  try {
    await agent.prompt(run.prompt);
    await settleRun(agent, run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent Runtime 失败";
    await failActiveRun({ userId: input.userId, runId: input.runId, code: "AGENT_RUNTIME_FAILED", error: message });
  }
}

export const runReadOnlyAgentTask = runAgentTask;

export type ResumeKind = "change" | "exec";

/**
 * Resumes a waiting_approval run after the user resolved a proposal.
 *
 * - change kind: the approval outcome is injected as a model-visible user
 *   message and the loop continues in place (auto-continue).
 * - exec kind: the approved execution runs in the Sandbox first; the real
 *   result replaces the staged placeholder tool result, then the loop
 *   continues with the actual output.
 *
 * If the process restarted while waiting, the in-memory Agent is gone. Change
 * approvals finalize safely; exec approvals still run and record the sandbox
 * result so the approved execution is never silently dropped.
 */
export async function resumeAgentRun(input: { userId: string; runId: string; kind: ResumeKind; note: string; proposalId?: string }): Promise<void> {
  const run = await TaskRunModel.findOne({ userId: input.userId, runId: input.runId, status: "waiting_approval" }).lean();
  if (!run) return; // Already terminal or cancelled while waiting.

  const agent = agents.get(input.runId);
  if (!agent && input.kind !== "exec") {
    const finalized = await TaskRunModel.findOneAndUpdate(
      { userId: input.userId, runId: input.runId, status: "waiting_approval" },
      { $set: { status: "succeeded", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, failureCode: null }, $unset: { activeWorkspaceKey: 1 } },
      { new: true },
    ).lean();
    if (finalized) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.completed", data: { note: "运行上下文已随服务重启丢失，本轮已安全结束；可在同一会话继续对话。" } });
    return;
  }

  const reacquired = await TaskRunModel.findOneAndUpdate(
    { userId: input.userId, runId: input.runId, status: "waiting_approval" },
    { $set: { status: "running", leaseOwner: `node:${process.pid}`, leaseExpiresAt: new Date(Date.now() + leaseDurationMs) } },
    { new: true },
  ).lean();
  if (!reacquired) return; // Cancelled between lookup and lease re-acquire.

  await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.resumed", data: { kind: input.kind, note: input.note } });

  try {
    if (input.kind === "exec" && input.proposalId) {
      const proposal = await getExecutionProposal({ userId: input.userId, proposalId: input.proposalId });
      if (agent && proposal?.status === "approved") {
        const result = await resumeApprovedExecution({ userId: input.userId, runId: input.runId, workspaceId: run.workspaceId, proposalId: input.proposalId });
        injectToolResult(agent, result.toolCallId, result);
        agent.state.messages = [...agent.state.messages, { role: "user", content: input.note, timestamp: Date.now() }];
        await agent.continue();
        await settleRun(agent, run);
        return;
      }
      if (proposal?.status === "approved") {
        // Approved but the in-memory Agent is gone: still run and record the
        // sandbox result in events, then finalize without a continuation.
        await resumeApprovedExecution({ userId: input.userId, runId: input.runId, workspaceId: run.workspaceId, proposalId: input.proposalId });
        const finalized = await TaskRunModel.findOneAndUpdate(
          { userId: input.userId, runId: input.runId, status: "running" },
          { $set: { status: "succeeded", finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, failureCode: null }, $unset: { activeWorkspaceKey: 1 } },
          { new: true },
        ).lean();
        if (finalized) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.completed", data: { note: "沙箱执行已完成；运行上下文已随服务重启丢失，可在同一会话继续对话。" } });
        return;
      }
      if (!agent) return;
      // Rejected or otherwise non-approved: no sandbox run, just continue.
      agent.state.messages = [...agent.state.messages, { role: "user", content: input.note, timestamp: Date.now() }];
      await agent.continue();
      await settleRun(agent, run);
      return;
    }

    if (!agent) return;
    agent.state.messages = [...agent.state.messages, { role: "user", content: input.note, timestamp: Date.now() }];
    await agent.continue();
    await settleRun(agent, run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent Runtime 恢复失败";
    await failActiveRun({ userId: input.userId, runId: input.runId, code: "AGENT_RUNTIME_FAILED", error: message });
  }
}

/** Replaces the staged placeholder tool result with the real execution output. */
function injectToolResult(agent: Agent, toolCallId: string, result: { outputText: string; exitCode: number | null }): void {
  const messages = agent.state.messages;
  const index = messages.findIndex((message) => message.role === "toolResult" && "toolCallId" in message && message.toolCallId === toolCallId);
  if (index === -1) return;
  const output = result.outputText.trim();
  const text = output || (result.exitCode === 0 ? "（无输出）" : `命令以退出码 ${result.exitCode} 结束`);
  const previous = messages[index] as { toolCallId: string; toolName: string; timestamp: number; details?: unknown };
  messages[index] = {
    role: "toolResult",
    toolCallId: previous.toolCallId,
    toolName: previous.toolName,
    content: [{ type: "text", text }],
    isError: (result.exitCode ?? 0) !== 0,
    timestamp: previous.timestamp,
    ...(previous.details !== undefined ? { details: previous.details } : {}),
  } as AgentMessage;
  agent.state.messages = messages;
}

export function cancelActiveAgentRun(runId: string): void {
  const agent = agents.get(runId);
  agents.delete(runId);
  agent?.abort();
}

export function isAgentAlive(runId: string): boolean {
  return agents.has(runId);
}
