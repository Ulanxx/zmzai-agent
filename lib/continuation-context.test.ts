import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildContinuationMessages, ContinuationError, prepareContinuation } from "@/lib/continuation-context";

vi.mock("@/models/task-run", () => ({
  TaskRunModel: {
    findOne: vi.fn(),
    find: vi.fn(),
  },
}));

vi.mock("@/lib/task-events", () => ({
  listTaskEvents: vi.fn(),
}));

vi.mock("@/lib/proposals", () => ({
  listRunProposals: vi.fn(),
}));

import { TaskRunModel } from "@/models/task-run";
import { listTaskEvents } from "@/lib/task-events";
import { listRunProposals } from "@/lib/proposals";

function chain(value: unknown) {
  const resolver = { lean: vi.fn().mockResolvedValue(value) };
  return { ...resolver, sort: () => resolver } as never;
}

function runRecord(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run_1",
    workspaceId: "ws_1",
    userId: "user_1",
    sessionId: "session_1",
    mode: "plan",
    model: "model-x",
    prompt: "分析一下这个项目",
    baseRevisionId: null,
    parentRunId: null,
    status: "succeeded",
    failureCode: null,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:01:00.000Z"),
    ...overrides,
  };
}

const taskRunModel = vi.mocked(TaskRunModel);
const listTaskEventsMock = vi.mocked(listTaskEvents);
const listRunProposalsMock = vi.mocked(listRunProposals);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareContinuation", () => {
  it("rejects a missing previous run", async () => {
    taskRunModel.findOne.mockReturnValue(chain(null));
    await expect(prepareContinuation({ userId: "user_1", workspaceId: "ws_1", continueFromRunId: "run_x" })).rejects.toMatchObject({ code: "CONTINUATION_NOT_FOUND" });
  });

  it("rejects cross-workspace continuation", async () => {
    taskRunModel.findOne.mockReturnValue(chain(runRecord({ workspaceId: "ws_other" })));
    await expect(prepareContinuation({ userId: "user_1", workspaceId: "ws_1", continueFromRunId: "run_1" })).rejects.toMatchObject({ code: "CONTINUATION_WORKSPACE_MISMATCH" });
  });

  it("rejects continuing an active run", async () => {
    taskRunModel.findOne.mockReturnValue(chain(runRecord({ status: "running" })));
    await expect(prepareContinuation({ userId: "user_1", workspaceId: "ws_1", continueFromRunId: "run_1" })).rejects.toMatchObject({ code: "CONTINUATION_NOT_TERMINAL" });
  });

  it("returns the parent session and run id for a terminal run", async () => {
    taskRunModel.findOne.mockReturnValue(chain(runRecord({ status: "failed" })));
    await expect(prepareContinuation({ userId: "user_1", workspaceId: "ws_1", continueFromRunId: "run_1" })).resolves.toEqual({ sessionId: "session_1", parentRunId: "run_1" });
  });
});

describe("buildContinuationMessages", () => {
  it("returns an empty seed when the anchor run is missing", async () => {
    taskRunModel.findOne.mockReturnValue(chain(null));
    await expect(buildContinuationMessages({ userId: "user_1", runId: "run_x" })).resolves.toEqual([]);
  });

  it("compacts prompts, assistant replies, tool activity and the terminal outcome", async () => {
    taskRunModel.findOne.mockReturnValue(chain(runRecord()));
    taskRunModel.find.mockReturnValue(chain([
      runRecord({ prompt: "第一个问题" }),
      runRecord({ runId: "run_2", status: "failed", failureCode: "RELAY_OR_AGENT_FAILED", prompt: "再试一次" }),
    ]));
    listTaskEventsMock.mockImplementation(async (runId) => {
      if (runId === "run_1") {
        return [
          { id: "e1", runId: "run_1", sequence: 1, type: "message.started", at: "", data: { messageId: "m1" } },
          { id: "e2", runId: "run_1", sequence: 2, type: "message.delta", at: "", data: { messageId: "m1", delta: "这是" } },
          { id: "e3", runId: "run_1", sequence: 3, type: "message.delta", at: "", data: { messageId: "m1", delta: "回复" } },
          { id: "e4", runId: "run_1", sequence: 4, type: "tool.requested", at: "", data: { toolCallId: "c1", name: "read" } },
          { id: "e5", runId: "run_1", sequence: 5, type: "tool.requested", at: "", data: { toolCallId: "c2", name: "search" } },
          { id: "e6", runId: "run_1", sequence: 6, type: "tool.requested", at: "", data: { toolCallId: "c3", name: "read" } },
        ];
      }
      return [
        { id: "e7", runId: "run_2", sequence: 1, type: "message.delta", at: "", data: { messageId: "m2", delta: "尝试继续" } },
        { id: "e8", runId: "run_2", sequence: 2, type: "run.failed", at: "", data: { code: "RELAY_OR_AGENT_FAILED", error: "模型超时" } },
      ];
    });
    listRunProposalsMock.mockResolvedValue([]);

    const [seed] = await buildContinuationMessages({ userId: "user_1", runId: "run_2" });

    expect(seed.role).toBe("user");
    expect(seed.content).toContain("用户请求：第一个问题");
    expect(seed.content).toContain("Agent 回复：这是回复");
    expect(seed.content).toContain("工具活动：read×2、search");
    expect(seed.content).toContain("结局：任务完成");
    expect(seed.content).toContain("用户请求：再试一次");
    expect(seed.content).toContain("结局：任务失败：模型超时");
  });

  it("reports the latest proposal outcome", async () => {
    taskRunModel.findOne.mockReturnValue(chain(runRecord()));
    taskRunModel.find.mockReturnValue(chain([runRecord({ prompt: "加个按钮" })]));
    listTaskEventsMock.mockResolvedValue([]);
    listRunProposalsMock.mockResolvedValue([
      {
        id: "prop_1",
        runId: "run_1",
        kind: "change",
        baseRevisionId: "rev_1",
        status: "approved",
        approvedRevisionId: "rev_2",
        summary: "add button",
        diff: "",
        changes: [],
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ]);

    const [seed] = await buildContinuationMessages({ userId: "user_1", runId: "run_1" });

    expect(seed.content).toContain("结局：文件变更提案已批准，已提交为版本 rev_2");
  });

  it("caps the number of prior runs", async () => {
    taskRunModel.findOne.mockReturnValue(chain(runRecord()));
    taskRunModel.find.mockReturnValue(chain(Array.from({ length: 20 }, (_, index) => runRecord({ runId: `run_${index}`, prompt: `问题 ${index}` }))));
    listTaskEventsMock.mockResolvedValue([]);
    listRunProposalsMock.mockResolvedValue([]);

    const [seed] = await buildContinuationMessages({ userId: "user_1", runId: "run_1" });

    expect(seed.content).toContain("问题 19");
    expect(seed.content).not.toContain("问题 0");
  });

  it("throws no ContinuationError for an unknown anchor inside building", async () => {
    taskRunModel.findOne.mockReturnValue(chain(null));
    const seed = await buildContinuationMessages({ userId: "user_1", runId: "run_x" });
    expect(seed).toEqual([]);
    expect(ContinuationError).toBeDefined();
  });
});
