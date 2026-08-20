import type { EventLog, FrameworkEvent, PersistedFrameworkEvent } from "@zmzai/agent-framework";

import { mongoEventLog } from "@/framework/core/events/mongo-event-log";
import { projectFrameworkEvent } from "@/lib/task-run-control";
import { persistTaskCheckpoint } from "@/lib/task-checkpoint";

/** Product event log: durable framework events remain the source stream, while
 * Task/Run is updated as a best-effort projection that can be rebuilt later. */
export const productEventLog: EventLog = {
  async append(event: FrameworkEvent & { sessionId: string }): Promise<PersistedFrameworkEvent> {
    const persisted = await mongoEventLog.append(event);
    await projectFrameworkEvent(persisted).catch((error) => {
      console.error("project framework event to Task/Run", error);
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
    await persistTaskCheckpoint(persisted).catch((error) => {
      console.error("persist Task/Run checkpoint", error);
    });
    return persisted;
  },
  read: mongoEventLog.read.bind(mongoEventLog),
  count: mongoEventLog.count.bind(mongoEventLog),
};
