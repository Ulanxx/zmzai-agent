import { describe, expect, it } from "vitest";

import { InvalidRunTransitionError, canStartContinuationRun, canSupersedeActiveRun, canTransitionRun, isActiveRunStatus, taskStatusForRun, transitionRun } from "@/lib/task-state-machine";

describe("Task/Run state machine", () => {
  it("allows only the product-defined Run transitions", () => {
    expect(transitionRun("created", "running")).toBe("running");
    expect(transitionRun("running", "waiting_approval")).toBe("waiting_approval");
    expect(transitionRun("waiting_input", "running")).toBe("running");
    expect(transitionRun("running", "succeeded")).toBe("succeeded");
  });

  it("does not mutate a terminal Run for retry or continuation", () => {
    expect(canTransitionRun("succeeded", "running")).toBe(false);
    expect(() => transitionRun("failed", "running")).toThrow(InvalidRunTransitionError);
  });

  it("treats paused and waiting states as active", () => {
    expect(isActiveRunStatus("created")).toBe(true);
    expect(isActiveRunStatus("paused")).toBe(true);
    expect(isActiveRunStatus("succeeded")).toBe(false);
  });

  it("derives terminal Task status only from terminal Run states", () => {
    expect(taskStatusForRun("running")).toBe("active");
    expect(taskStatusForRun("waiting_input")).toBe("active");
    expect(taskStatusForRun("succeeded")).toBe("succeeded");
    expect(taskStatusForRun("failed")).toBe("failed");
    expect(taskStatusForRun("cancelled")).toBe("cancelled");
  });

  it("only permits continuation after an inert or terminal source Run", () => {
    expect(canStartContinuationRun("resume", "paused")).toBe(true);
    expect(canStartContinuationRun("resume", "waiting_input")).toBe(true);
    expect(canStartContinuationRun("resume", "running")).toBe(false);
    expect(canStartContinuationRun("retry", "failed")).toBe(true);
    expect(canStartContinuationRun("follow_up", "succeeded")).toBe(true);
    expect(canStartContinuationRun("retry", "waiting_approval")).toBe(false);
    expect(canSupersedeActiveRun("paused")).toBe(true);
    expect(canSupersedeActiveRun("running")).toBe(false);
  });
});
