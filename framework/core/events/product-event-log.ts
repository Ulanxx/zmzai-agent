import type { EventLog, FrameworkEvent, PersistedFrameworkEvent } from "@zmzai/agent-framework";

import { mongoEventLog } from "@/framework/core/events/mongo-event-log";
import { projectFrameworkEvent } from "@/lib/task-run-control";
import { persistTaskCheckpoint } from "@/lib/task-checkpoint";
import { projectApprovalEvent } from "@/lib/approval-projection";

/** Product event log: durable framework events remain the source stream, while
 * Task/Run is updated as a best-effort projection that can be rebuilt later. */
export const productEventLog: EventLog = {
  async append(event: FrameworkEvent & { sessionId: string }): Promise<PersistedFrameworkEvent> {
    const persisted = await mongoEventLog.append(event);
    await projectFrameworkEvent(persisted).catch((error) => {
      console.error("project framework event to Task/Run", error);
    });
    await projectApprovalEvent(persisted).catch((error) => {
      console.error("project framework event to Approval", error);
    });
    if (persisted.type === "session.status" && persisted.data.status === "idle") {
      await import("@/lib/automation-execution").then(({ projectAutomationExecution }) => projectAutomationExecution({ sessionId: persisted.sessionId, status: "succeeded" })).catch((error) => {
        console.error("project automation execution success", error);
      });
    }
    if (persisted.type === "session.error") {
      await import("@/lib/automation-execution").then(({ projectAutomationExecution }) => projectAutomationExecution({ sessionId: persisted.sessionId, status: "failed", error: `${persisted.data.name}: ${persisted.data.message}` })).catch((error) => {
        console.error("project automation execution failure", error);
      });
    }
    const updatedPart = persisted.type === "message.part.updated" ? persisted.data.part : null;
    if (updatedPart?.type === "tool" && updatedPart.tool === "qa-check" && updatedPart.state.status === "completed") {
      const entryPath = typeof updatedPart.state.input === "object" && updatedPart.state.input !== null && "entryPath" in updatedPart.state.input && typeof (updatedPart.state.input as { entryPath?: unknown }).entryPath === "string"
        ? (updatedPart.state.input as { entryPath: string }).entryPath
        : "index.html";
      const qaResult = updatedPart.state.metadata?.qaCheck;
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
