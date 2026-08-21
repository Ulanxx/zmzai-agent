import type { EventLog, FrameworkEvent, PersistedFrameworkEvent } from "@zmzai/agent-framework";

import { mongoEventLog } from "@/framework/core/events/mongo-event-log";
import { projectFrameworkEvent, transitionRunForSession } from "@/lib/task-run-control";
import { persistTaskCheckpoint } from "@/lib/task-checkpoint";
import { projectApprovalEvent } from "@/lib/approval-projection";
import { projectSubagentEvent } from "@/lib/subagent-projection";
import { RunModel } from "@/models/run";
import { qualityGateFailureReason } from "@/lib/task-quality-gate";
import { recordProjectTokenUsage } from "@/lib/project-budget";

async function publishOutboundTaskEvent(sessionId: string, eventType: "task.succeeded" | "task.failed" | "task.cancelled"): Promise<void> {
  const { dispatchDueWebhookDeliveries, enqueueTaskWebhookEvent } = await import("@/lib/outbound-webhooks");
  await enqueueTaskWebhookEvent({ sessionId, eventType });
  // Delivery is durable before this background attempt. The internal tick can
  // retry anything that fails after a restart or transient network error.
  void dispatchDueWebhookDeliveries({ limit: 10 }).catch((error) => console.error("dispatch outbound webhook", error));
}

/** Product event log: durable framework events remain the source stream, while
 * Task/Run is updated as a best-effort projection that can be rebuilt later. */
export const productEventLog: EventLog = {
  async append(event: FrameworkEvent & { sessionId: string }): Promise<PersistedFrameworkEvent> {
    const persisted = await mongoEventLog.append(event);
    const qualityGateFailed = persisted.type === "session.status" && persisted.data.status === "idle"
      ? qualityGateFailureReason(await mongoEventLog.read(persisted.sessionId, 0, 5_000))
      : null;
    if (qualityGateFailed) {
      await transitionRunForSession(persisted.sessionId, "failed", qualityGateFailed).catch((error) => {
        console.error("project quality-gated Task/Run failure", error);
      });
    } else await projectFrameworkEvent(persisted).catch((error) => {
      console.error("project framework event to Task/Run", error);
    });
    await projectApprovalEvent(persisted).catch((error) => {
      console.error("project framework event to Approval", error);
    });
    await projectSubagentEvent(persisted).catch((error) => {
      console.error("project framework event to Subagent", error);
    });
    if (persisted.type === "session.status" && persisted.data.status === "idle" && !qualityGateFailed) {
      const latestRun = await RunModel.findOne({ sessionId: persisted.sessionId }).sort({ createdAt: -1 }).select({ runId: 1, status: 1 }).lean();
      if (latestRun?.status === "succeeded" || latestRun?.status === "cancelled") await import("@/lib/task-run-control").then(({ releaseRunBudget }) => releaseRunBudget(latestRun.runId)).catch((error) => console.error("release project run budget", error));
      if (latestRun?.status === "succeeded") await import("@/lib/automation-execution").then(({ projectAutomationExecution }) => projectAutomationExecution({ sessionId: persisted.sessionId, status: "succeeded" })).catch((error) => {
        console.error("project automation execution success", error);
      });
      if (latestRun?.status === "succeeded") await publishOutboundTaskEvent(persisted.sessionId, "task.succeeded").catch((error) => {
        console.error("queue outbound task success webhook", error);
      });
      if (latestRun?.status === "succeeded" || latestRun?.status === "cancelled") {
        await import("@/lib/project-budget").then(({ reconcileRunRelayUsage }) => reconcileRunRelayUsage(latestRun.runId)).catch((error) => {
          console.error("reconcile Relay project usage", error);
        });
      }
    }
    if (persisted.type === "session.error") {
      const failedRun = await RunModel.findOne({ sessionId: persisted.sessionId }).sort({ createdAt: -1 }).select({ runId: 1 }).lean();
      if (failedRun) await import("@/lib/task-run-control").then(({ releaseRunBudget }) => releaseRunBudget(failedRun.runId)).catch((error) => console.error("release project run budget", error));
      await import("@/lib/automation-execution").then(({ projectAutomationExecution }) => projectAutomationExecution({ sessionId: persisted.sessionId, status: "failed", error: `${persisted.data.name}: ${persisted.data.message}` })).catch((error) => {
        console.error("project automation execution failure", error);
      });
      await publishOutboundTaskEvent(persisted.sessionId, "task.failed").catch((error) => {
        console.error("queue outbound task failure webhook", error);
      });
      if (failedRun) await import("@/lib/project-budget").then(({ reconcileRunRelayUsage }) => reconcileRunRelayUsage(failedRun.runId)).catch((error) => {
        console.error("reconcile Relay project usage", error);
      });
    }
    if (qualityGateFailed) {
      const failedRun = await RunModel.findOne({ sessionId: persisted.sessionId }).sort({ createdAt: -1 }).select({ runId: 1 }).lean();
      if (failedRun) await import("@/lib/task-run-control").then(({ releaseRunBudget }) => releaseRunBudget(failedRun.runId)).catch((error) => console.error("release project run budget", error));
      await import("@/lib/automation-execution").then(({ projectAutomationExecution }) => projectAutomationExecution({ sessionId: persisted.sessionId, status: "failed", error: qualityGateFailed })).catch((error) => {
        console.error("project automation quality-gate failure", error);
      });
      await publishOutboundTaskEvent(persisted.sessionId, "task.failed").catch((error) => {
        console.error("queue outbound quality-gate webhook", error);
      });
    }
    const updatedPart = persisted.type === "message.part.updated" ? persisted.data.part : null;
    if (persisted.type === "message.updated" && persisted.data.message.role === "assistant" && persisted.data.message.tokens) {
      await recordProjectTokenUsage({
        eventId: persisted.id,
        sessionId: persisted.sessionId,
        inputTokens: persisted.data.message.tokens.input,
        outputTokens: persisted.data.message.tokens.output,
        cacheReadTokens: persisted.data.message.tokens.cacheRead,
        cacheWriteTokens: persisted.data.message.tokens.cacheWrite,
      }).catch((error) => console.error("project token usage", error));
    }
    if (updatedPart?.type === "tool" && updatedPart.tool === "qa-check" && updatedPart.state.status === "completed") {
      const entryPath = typeof updatedPart.state.input === "object" && updatedPart.state.input !== null && "entryPath" in updatedPart.state.input && typeof (updatedPart.state.input as { entryPath?: unknown }).entryPath === "string"
        ? (updatedPart.state.input as { entryPath: string }).entryPath
        : "index.html";
      const qaResult = updatedPart.state.metadata?.qaCheck;
      const qaStatus = typeof qaResult === "object" && qaResult !== null && "status" in qaResult && ((qaResult as { status?: unknown }).status === "passed" || (qaResult as { status?: unknown }).status === "failed")
        ? (qaResult as { status: "passed" | "failed" }).status
        : null;
      if (qaStatus) await import("@/lib/web-app-artifact").then(({ materializeWebAppArtifacts }) => materializeWebAppArtifacts({ sessionId: persisted.sessionId, entryPath, toolCallId: updatedPart.callId, qualityStatus: qaStatus })).catch((error) => {
        console.error("materialize web app artifacts", error);
      });
      await import("@/lib/artifact-metadata").then(({ projectArtifactQuality }) => projectArtifactQuality({ sessionId: persisted.sessionId, entryPath, result: qaResult })).catch((error) => {
        console.error("project artifact quality", error);
      });
    }
    await persistTaskCheckpoint(persisted).catch((error) => {
      console.error("persist Task/Run checkpoint", error);
    });
    return persisted;
  },
  read: mongoEventLog.read.bind(mongoEventLog),
  count: mongoEventLog.count.bind(mongoEventLog),
};
