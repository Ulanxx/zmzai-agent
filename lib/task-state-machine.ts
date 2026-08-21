export const taskStatuses = ["draft", "active", "succeeded", "failed", "cancelled"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const runStatuses = ["created", "running", "waiting_input", "waiting_approval", "paused", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof runStatuses)[number];

export const activeRunStatuses = ["created", "running", "waiting_input", "waiting_approval", "paused"] as const;
export const terminalRunStatuses = ["succeeded", "failed", "cancelled"] as const;

export type ContinuationAction = "resume" | "retry" | "follow_up";

const runTransitions: Record<RunStatus, readonly RunStatus[]> = {
  created: ["running", "cancelled"],
  running: ["waiting_input", "waiting_approval", "paused", "succeeded", "failed", "cancelled"],
  waiting_input: ["running", "paused", "cancelled", "failed"],
  waiting_approval: ["running", "paused", "cancelled", "failed"],
  paused: ["cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class InvalidRunTransitionError extends Error {
  constructor(public readonly from: RunStatus, public readonly to: RunStatus) {
    super(`非法 Run 状态转换：${from} → ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return (activeRunStatuses as readonly string[]).includes(status);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (terminalRunStatuses as readonly string[]).includes(status);
}

/** A continuation must never replace a live executor. Paused and explicit
 * waiting-input runs are inert; all other active states require pause/cancel
 * or lease recovery before a new Run can be created. */
export function canStartContinuationRun(action: ContinuationAction, status: RunStatus): boolean {
  if (action === "resume") return status === "paused" || status === "waiting_input";
  return isTerminalRunStatus(status);
}

export function canSupersedeActiveRun(status: RunStatus): boolean {
  return status === "paused" || status === "waiting_input";
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return runTransitions[from].includes(to);
}

export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransitionRun(from, to)) throw new InvalidRunTransitionError(from, to);
  return to;
}

export function taskStatusForRun(status: RunStatus): TaskStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "active";
}
