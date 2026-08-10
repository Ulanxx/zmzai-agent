import { Agent } from "@earendil-works/pi-agent-core";

import { appendTaskEvent } from "@/lib/task-events";
import { createBuildTools } from "@/lib/build-tool-broker";
import { hasPendingProposals } from "@/lib/proposals";
import { createRelayModel, createRelayStreamFunction } from "@/lib/relay-agent-stream";
import { createReadOnlyTools } from "@/lib/read-only-tool-broker";
import { presentAgentEvent } from "@/lib/task-event-presentation";
import { TaskRunModel } from "@/models/task-run";
import { WorkspaceModel } from "@/models/workspace";

const runningAgents = globalThis as typeof globalThis & { __zmzaiAgentRuntime?: Map<string, Agent> };
const agents = runningAgents.__zmzaiAgentRuntime ?? new Map<string, Agent>();
runningAgents.__zmzaiAgentRuntime = agents;

export async function runAgentTask(input: { userId: string; runId: string }): Promise<void> {
  const run = await TaskRunModel.findOneAndUpdate(
    { userId: input.userId, runId: input.runId, status: "queued" },
    { $set: { status: "running", leaseOwner: `node:${process.pid}`, leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000) } },
    { new: true },
  ).lean();
  if (!run) return;

  const workspace = await WorkspaceModel.exists({ workspaceId: run.workspaceId, userId: input.userId });
  if (!workspace) {
    await TaskRunModel.updateOne(
      { userId: input.userId, runId: input.runId, status: "running" },
      { $set: { status: "failed", leaseOwner: null, leaseExpiresAt: null, failureCode: "WORKSPACE_NOT_FOUND" }, $unset: { activeWorkspaceKey: 1 } },
    );
    await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.failed", data: { code: "WORKSPACE_NOT_FOUND", error: "Workspace 不存在或不可访问" } });
    return;
  }

  await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.started", data: { mode: run.mode, model: run.model } });
  const buildMode = run.mode === "build";
  const agent = new Agent({
    initialState: {
      systemPrompt: buildMode
        ? "你是 ZMZAI Agent。可使用已注册的读取工具分析当前 Workspace，也可通过 write 或 edit 生成待审批的文件变更提案。提案不会立即修改 Workspace；不能声称已提交、执行或批准任何变更。用中文给出简洁、可核实的结果。"
        : "你是 ZMZAI Agent。仅使用已注册工具读取当前 Workspace；不能声称执行了未调用的操作。用中文给出简洁、可核实的结果。",
      model: createRelayModel(run.model),
      tools: buildMode
        ? createBuildTools({ userId: input.userId, workspaceId: run.workspaceId, runId: input.runId, baseRevisionId: run.baseRevisionId ?? null })
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
    const failed = agent.state.errorMessage;
    const waitingApproval = !failed && buildMode && await hasPendingProposals(input.runId);
    const terminalUpdate = failed || !waitingApproval
      ? { $set: { status: failed ? "failed" : "succeeded", leaseOwner: null, leaseExpiresAt: null, failureCode: failed ? "RELAY_OR_AGENT_FAILED" : null }, $unset: { activeWorkspaceKey: 1 } }
      : { $set: { status: "waiting_approval", activeWorkspaceKey: run.workspaceId, leaseOwner: null, leaseExpiresAt: null, failureCode: null } };
    const finalized = await TaskRunModel.findOneAndUpdate(
      { userId: input.userId, runId: input.runId, status: "running" },
      terminalUpdate,
      { new: true },
    ).lean();
    if (finalized && waitingApproval) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.waiting_approval", data: {} });
    if (finalized && !waitingApproval) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: failed ? "run.failed" : "run.completed", data: failed ? { code: "RELAY_OR_AGENT_FAILED", error: failed } : {} });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent Runtime 失败";
    const failedRun = await TaskRunModel.findOneAndUpdate(
      { userId: input.userId, runId: input.runId, status: "running" },
      { $set: { status: "failed", leaseOwner: null, leaseExpiresAt: null, failureCode: "AGENT_RUNTIME_FAILED" }, $unset: { activeWorkspaceKey: 1 } },
      { new: true },
    ).lean();
    if (failedRun) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.failed", data: { code: "AGENT_RUNTIME_FAILED", error: message } });
  } finally {
    agents.delete(input.runId);
  }
}

export const runReadOnlyAgentTask = runAgentTask;

export function cancelActiveAgentRun(runId: string): void {
  agents.get(runId)?.abort();
}
