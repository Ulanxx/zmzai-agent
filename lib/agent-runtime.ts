import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";

import { appendTaskEvent } from "@/lib/task-events";
import { createRelayModel, createRelayStreamFunction } from "@/lib/relay-agent-stream";
import { createReadOnlyTools } from "@/lib/read-only-tool-broker";
import { TaskRunModel } from "@/models/task-run";
import { WorkspaceModel } from "@/models/workspace";

const runningAgents = globalThis as typeof globalThis & { __zmzaiAgentRuntime?: Map<string, Agent> };
const agents = runningAgents.__zmzaiAgentRuntime ?? new Map<string, Agent>();
runningAgents.__zmzaiAgentRuntime = agents;

function eventForUi(event: AgentEvent): { type: string; data: unknown } | null {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") return { type: "message.delta", data: { delta: event.assistantMessageEvent.delta } };
  if (event.type === "tool_execution_start") return { type: "tool.requested", data: { toolCallId: event.toolCallId, name: event.toolName, args: event.args } };
  if (event.type === "tool_execution_update") return { type: "tool.progress", data: { toolCallId: event.toolCallId, name: event.toolName } };
  if (event.type === "tool_execution_end") return { type: "tool.completed", data: { toolCallId: event.toolCallId, name: event.toolName, isError: event.isError } };
  return null;
}

export async function runReadOnlyAgentTask(input: { userId: string; runId: string }): Promise<void> {
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
      { $set: { status: "failed", activeWorkspaceKey: null, leaseOwner: null, leaseExpiresAt: null, failureCode: "WORKSPACE_NOT_FOUND" } },
    );
    await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.failed", data: { code: "WORKSPACE_NOT_FOUND", error: "Workspace 不存在或不可访问" } });
    return;
  }

  await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.started", data: { mode: run.mode, model: run.model } });
  const agent = new Agent({
    initialState: {
      systemPrompt: "你是 ZMZAI Agent。仅使用已注册工具读取当前 Workspace；不能声称执行了未调用的操作。用中文给出简洁、可核实的结果。",
      model: createRelayModel(run.model),
      tools: createReadOnlyTools({ userId: input.userId, workspaceId: run.workspaceId }),
    },
    streamFn: createRelayStreamFunction({ userId: input.userId, taskRunId: input.runId }),
    toolExecution: "sequential",
    shouldStopAfterTurn: ({ newMessages }) => newMessages.filter((message) => message.role === "assistant").length >= (run.budget?.maxModelTurns ?? 12),
  });
  agents.set(input.runId, agent);
  agent.subscribe(async (event) => {
    const visible = eventForUi(event);
    if (visible) await appendTaskEvent({ runId: input.runId, userId: input.userId, ...visible });
  });

  try {
    await agent.prompt(run.prompt);
    const failed = agent.state.errorMessage;
    const finalized = await TaskRunModel.findOneAndUpdate(
      { userId: input.userId, runId: input.runId, status: "running" },
      { $set: { status: failed ? "failed" : "succeeded", activeWorkspaceKey: null, leaseOwner: null, leaseExpiresAt: null, failureCode: failed ? "RELAY_OR_AGENT_FAILED" : null } },
      { new: true },
    ).lean();
    if (finalized) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: failed ? "run.failed" : "run.completed", data: failed ? { code: "RELAY_OR_AGENT_FAILED", error: failed } : {} });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent Runtime 失败";
    const failedRun = await TaskRunModel.findOneAndUpdate(
      { userId: input.userId, runId: input.runId, status: "running" },
      { $set: { status: "failed", activeWorkspaceKey: null, leaseOwner: null, leaseExpiresAt: null, failureCode: "AGENT_RUNTIME_FAILED" } },
      { new: true },
    ).lean();
    if (failedRun) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "run.failed", data: { code: "AGENT_RUNTIME_FAILED", error: message } });
  } finally {
    agents.delete(input.runId);
  }
}

export function cancelActiveAgentRun(runId: string): void {
  agents.get(runId)?.abort();
}
