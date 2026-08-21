import type { PersistedFrameworkEvent } from "@zmzai/agent-framework";

export function latestQaCheckStatus(events: PersistedFrameworkEvent[]): "passed" | "failed" | null {
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    if (event.type !== "message.part.updated" || event.data.part.type !== "tool" || event.data.part.tool !== "qa-check") continue;
    if (event.data.part.state.status !== "completed") continue;
    const result = event.data.part.state.metadata?.qaCheck;
    if (typeof result !== "object" || result === null || !("status" in result)) continue;
    const status = (result as { status?: unknown }).status;
    if (status === "passed" || status === "failed") return status;
  }
  return null;
}

export function qualityGateFailureReason(events: PersistedFrameworkEvent[]): string | null {
  const qaStatus = latestQaCheckStatus(events);
  if (qaStatus === "failed") return "QA_CHECK_FAILED";

  // A static web_app is a user-facing deliverable, not an incidental source
  // file. It may only finish successfully after its QA result is persisted.
  // Other artifact kinds do not require this web-specific gate.
  const hasWebApp = events.some((event) => event.type === "artifact.created" && event.data.path === "index.html");
  return hasWebApp && qaStatus !== "passed" ? "QA_CHECK_REQUIRED" : null;
}
