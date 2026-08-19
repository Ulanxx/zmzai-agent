import { describe, expect, it } from "vitest";

import { ApprovalGrantModel, ApprovalRequestModel } from "@/models/approval";
import { CheckpointModel } from "@/models/checkpoint";
import { RunModel } from "@/models/run";
import { TaskModel } from "@/models/task";

describe("B0 Task/Run models", () => {
  it("validates the minimum Task and Run records", async () => {
    const task = new TaskModel({ taskId: "task_1", workspaceId: "ws_1", userId: "u_1", title: "分析销售数据", goal: "读取 sales.csv 并生成看板" });
    await expect(task.validate()).resolves.toBeUndefined();
    expect(task.status).toBe("draft");

    const run = new RunModel({ runId: "run_1", taskId: "task_1", workspaceId: "ws_1", userId: "u_1", sessionId: "ses_1" });
    await expect(run.validate()).resolves.toBeUndefined();
    expect(run.status).toBe("created");
    expect(run.active).toBe(true);
  });

  it("keeps checkpoint and approval references immutable at creation", async () => {
    const checkpoint = new CheckpointModel({ checkpointId: "cp_1", taskId: "task_1", runId: "run_1", sessionId: "ses_1", eventSeq: 4, state: { status: "running" } });
    await expect(checkpoint.validate()).resolves.toBeUndefined();

    const request = new ApprovalRequestModel({ requestId: "apr_1", taskId: "task_1", runId: "run_1", requesterId: "u_1", action: "执行 Sandbox 命令", impact: "会在隔离环境中生成文件", resourceScope: ["workspace" ] });
    await expect(request.validate()).resolves.toBeUndefined();
    expect(request.status).toBe("pending");

    const grant = new ApprovalGrantModel({ grantId: "apg_1", taskId: "task_1", sourceRequestId: "apr_1", sourceRunId: "run_1", grantedBy: "u_1", action: "执行 Sandbox 命令", expiresAt: new Date(Date.now() + 60_000) });
    await expect(grant.validate()).resolves.toBeUndefined();
    expect(grant.allowContinuation).toBe(false);
  });
});
