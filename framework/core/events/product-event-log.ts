import type { EventLog, FrameworkEvent, PersistedFrameworkEvent } from "@zmzai/agent-framework";

import { mongoEventLog } from "@/framework/core/events/mongo-event-log";
import { projectFrameworkEvent } from "@/lib/task-run-control";

/** Product event log: durable framework events remain the source stream, while
 * Task/Run is updated as a best-effort projection that can be rebuilt later. */
export const productEventLog: EventLog = {
  async append(event: FrameworkEvent & { sessionId: string }): Promise<PersistedFrameworkEvent> {
    const persisted = await mongoEventLog.append(event);
    await projectFrameworkEvent(persisted).catch((error) => {
      console.error("project framework event to Task/Run", error);
    });
    return persisted;
  },
  read: mongoEventLog.read.bind(mongoEventLog),
  count: mongoEventLog.count.bind(mongoEventLog),
};
