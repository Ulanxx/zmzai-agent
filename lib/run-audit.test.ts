import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  taskRuns: [] as Array<Record<string, unknown>>,
  toolCalls: [] as Array<Record<string, unknown>>,
  artifacts: [] as Array<Record<string, unknown>>,
  workspaces: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/models/task-run", () => ({
  TaskRunModel: {
    find(filter: Record<string, unknown>) { return chainQuery(store.taskRuns, filter); },
    findOne(filter: Record<string, unknown>) { return one(store.taskRuns, filter); },
  },
  activeRunStates: ["queued", "running", "waiting_approval"],
  taskRunStates: ["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"],
}));

vi.mock("@/models/tool-call", () => ({
  ToolCallModel: {
    find(filter: Record<string, unknown>) { return chainQuery(store.toolCalls, filter); },
    aggregate() {
      const matched = store.toolCalls.filter((row) => typeof row.userId === "string");
      const byRun = new Map<string, { toolCount: number; failedToolCount: number }>();
      for (const row of matched) {
        const current = byRun.get(String(row.runId)) ?? { toolCount: 0, failedToolCount: 0 };
        current.toolCount += 1;
        if (row.status === "failed") current.failedToolCount += 1;
        byRun.set(String(row.runId), current);
      }
      return Promise.resolve([...byRun.entries()].map(([_id, counts]) => ({ _id, ...counts })));
    },
  },
}));

vi.mock("@/models/artifact-reference", () => ({
  ArtifactReferenceModel: {
    find(filter: Record<string, unknown>) { return chainQuery(store.artifacts, filter); },
  },
}));

vi.mock("@/models/workspace", () => ({
  WorkspaceModel: {
    find(filter: Record<string, unknown>) { return chainQuery(store.workspaces, filter); },
    findOne(filter: Record<string, unknown>) { return one(store.workspaces, filter); },
    exists(filter: Record<string, unknown>) { return Promise.resolve(select(store.workspaces, filter).length > 0); },
  },
}));

import {
  buildAuditRunFilter,
  decodeAuditCursor,
  encodeAuditCursor,
  getRunAuditDetail,
  listRunAudit,
  parseAuditListParams,
  runDurationMs,
  toAuditArtifact,
  toAuditRunSummary,
  toAuditToolCall,
  type AuditListParams,
} from "@/lib/run-audit";

type Row = Record<string, unknown>;

function compare(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : (typeof left === "number" || typeof left === "string" ? left : String(left));
  const b = right instanceof Date ? right.getTime() : (typeof right === "number" || typeof right === "string" ? right : String(right));
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function fieldMatch(value: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
    const operators = condition as Record<string, unknown>;
    return Object.entries(operators).every(([operator, expected]) => {
      if (operator === "$gte") return compare(value, expected) >= 0;
      if (operator === "$gt") return compare(value, expected) > 0;
      if (operator === "$lte") return compare(value, expected) <= 0;
      if (operator === "$lt") return compare(value, expected) < 0;
      if (operator === "$eq") return compare(value, expected) === 0;
      if (operator === "$in") return Array.isArray(expected) && expected.some((item) => compare(value, item) === 0);
      return true;
    });
  }
  return compare(value, condition) === 0;
}

function matchFilter(row: Row, filter: Record<string, unknown>): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if ("$and" in filter) return (filter.$and as Array<Record<string, unknown>>).every((condition) => matchFilter(row, condition));
  if ("$or" in filter) return (filter.$or as Array<Record<string, unknown>>).some((condition) => matchFilter(row, condition));
  return Object.entries(filter).every(([key, condition]) => fieldMatch(row[key], condition));
}

function select(rows: Row[], filter: Record<string, unknown>, sort?: Record<string, 1 | -1>, limit?: number): Row[] {
  let result = rows.filter((row) => matchFilter(row, filter));
  if (sort) {
    const keys = Object.keys(sort);
    result = [...result].sort((a, b) => {
      for (const key of keys) {
        const direction = sort[key];
        const ordered = compare(a[key], b[key]) * direction;
        if (ordered !== 0) return ordered;
      }
      return 0;
    });
  }
  if (limit !== undefined) result = result.slice(0, limit);
  return result;
}

// Real mongoose chain: .sort({}).limit(n).lean() — implement chainable methods.
function chainQuery(rows: Row[], filter: Record<string, unknown>) {
  return {
    _sort: undefined as Record<string, 1 | -1> | undefined,
    _limit: undefined as number | undefined,
    sort(value: Record<string, 1 | -1>) { this._sort = value; return this; },
    limit(value: number) { this._limit = value; return this; },
    lean() { return Promise.resolve(select(rows, filter, this._sort, this._limit)); },
  };
}

function one(rows: Row[], filter: Record<string, unknown>) {
  return { lean() { return Promise.resolve(select(rows, filter)[0] ?? null); } };
}

function runRow(overrides: Row = {}): Row {
  return {
    runId: "run_x",
    workspaceId: "ws_1",
    userId: "user_1",
    sessionId: "session_x",
    mode: "plan",
    model: "gpt-5.6-luna",
    prompt: "测试任务",
    status: "succeeded",
    failureCode: null,
    cancelRequestedAt: null,
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
    updatedAt: new Date("2026-08-10T10:00:00.000Z"),
    startedAt: null,
    finishedAt: null,
    leaseOwner: null,
    nextEventSequence: 3,
    persistedEventBytes: 120,
    budget: { maxModelTurns: 12 },
    ...overrides,
  };
}

function toolRow(overrides: Row = {}): Row {
  return {
    toolCallId: "call_1",
    runId: "run_1",
    userId: "user_1",
    name: "read",
    status: "completed",
    argsSummary: "read brief.md",
    label: "",
    resultSummary: { text: "已读取 brief.md", truncated: false, omittedBytes: 0 },
    durationMs: 24,
    requestedAt: new Date("2026-08-10T10:00:01.000Z"),
    completedAt: new Date("2026-08-10T10:00:01.024Z"),
    ...overrides,
  };
}

function artifactRow(overrides: Row = {}): Row {
  return {
    artifactId: "artifact_1",
    runId: "run_1",
    userId: "user_1",
    toolCallId: "call_1",
    kind: "file_preview",
    title: "brief.md",
    payload: { content: "hello" },
    payloadBytes: 12,
    truncated: false,
    omittedBytes: 0,
    createdAt: new Date("2026-08-10T10:00:02.000Z"),
    ...overrides,
  };
}

function params(overrides: Partial<AuditListParams> = {}): AuditListParams {
  return { range: "7d", workspaceId: null, status: null, cursor: null, limit: 30, ...overrides };
}

beforeEach(() => {
  store.taskRuns = [];
  store.toolCalls = [];
  store.artifacts = [];
  store.workspaces = [];
});

describe("parseAuditListParams", () => {
  it("defaults to 7d range, no filter and limit 30", () => {
    const result = parseAuditListParams(new URLSearchParams(""));
    expect(result).toEqual({ ok: true, value: params() });
  });

  it("accepts valid range, status, workspace and limit", () => {
    const result = parseAuditListParams(new URLSearchParams("range=24h&status=failed&workspaceId=ws_1&limit=5"));
    expect(result).toEqual({ ok: true, value: params({ range: "24h", status: "failed", workspaceId: "ws_1", limit: 5 }) });
  });

  it.each(["1h", "all", "30d "])("rejects invalid range %j", (range) => {
    expect(parseAuditListParams(new URLSearchParams(`range=${range}`))).toEqual({ ok: false });
  });

  it.each(["queued_extra", "unknown"])("rejects invalid status %j", (status) => {
    expect(parseAuditListParams(new URLSearchParams(`status=${status}`))).toEqual({ ok: false });
  });

  it.each(["0", "51", "abc", "1.5", "030"])("rejects invalid limit %j", (limit) => {
    expect(parseAuditListParams(new URLSearchParams(`limit=${limit}`))).toEqual({ ok: false });
  });

  it("rejects a malformed cursor", () => {
    expect(parseAuditListParams(new URLSearchParams("cursor=not-a-cursor"))).toEqual({ ok: false });
  });

  it("accepts a cursor produced by encodeAuditCursor", () => {
    const cursor = { createdAt: new Date("2026-08-10T09:00:00.000Z"), runId: "run_9" };
    const result = parseAuditListParams(new URLSearchParams(`cursor=${encodeAuditCursor(cursor)}`));
    expect(result).toEqual({ ok: true, value: params({ cursor: { createdAt: new Date("2026-08-10T09:00:00.000Z"), runId: "run_9" } }) });
  });
});

describe("audit cursor codec", () => {
  it("round-trips createdAt and runId", () => {
    const cursor = { createdAt: new Date("2026-08-10T12:34:56.789Z"), runId: "run_42" };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it("rejects values without the version prefix or corrupt payloads", () => {
    expect(decodeAuditCursor("abc")).toBeNull();
    expect(decodeAuditCursor("v1.!!!")).toBeNull();
    expect(decodeAuditCursor(`${encodeAuditCursor({ createdAt: new Date(), runId: "run_1" })}extra`)).toBeNull();
  });
});

describe("buildAuditRunFilter", () => {
  const now = new Date("2026-08-17T00:00:00.000Z").getTime();

  it("constrains userId and time range to the requested range", () => {
    const filter = buildAuditRunFilter({ userId: "user_1", params: params({ range: "7d" }) }, now);
    const and = filter.$and as Array<Record<string, unknown>>;
    expect(and[0]).toEqual({ userId: "user_1" });
    expect(and[1]).toEqual({ createdAt: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } });
  });

  it("omits workspace and status conditions when not requested", () => {
    const and = buildAuditRunFilter({ userId: "user_1", params: params() }, now).$and as Array<Record<string, unknown>>;
    expect(and.some((condition) => "workspaceId" in condition)).toBe(false);
    expect(and.some((condition) => "status" in condition)).toBe(false);
  });

  it("adds workspace and status conditions when requested", () => {
    const and = buildAuditRunFilter({ userId: "user_1", params: params({ workspaceId: "ws_1", status: "failed" }) }, now).$and as Array<Record<string, unknown>>;
    expect(and).toContainEqual({ workspaceId: "ws_1" });
    expect(and).toContainEqual({ status: "failed" });
  });

  it("continues strictly after the cursor without including it", () => {
    const cursor = { createdAt: new Date("2026-08-10T09:00:00.000Z"), runId: "run_9" };
    const and = buildAuditRunFilter({ userId: "user_1", params: params({ cursor }) }, now).$and as Array<Record<string, unknown>>;
    const continuation = and.find((condition) => "$or" in condition) as { $or: Array<Record<string, unknown>> };
    expect(continuation.$or).toEqual([
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, runId: { $lt: cursor.runId } },
    ]);
  });
});

describe("runDurationMs", () => {
  const startedAt = new Date("2026-08-10T10:00:00.000Z");
  const finishedAt = new Date("2026-08-10T10:05:30.000Z");

  it("computes terminal duration from finishedAt - startedAt", () => {
    expect(runDurationMs({ status: "succeeded", startedAt, finishedAt })).toBe(330_000);
  });

  it("uses now - startedAt for active and waiting_approval runs", () => {
    const now = new Date("2026-08-10T10:10:00.000Z").getTime();
    expect(runDurationMs({ status: "running", startedAt }, now)).toBe(600_000);
    expect(runDurationMs({ status: "waiting_approval", startedAt }, now)).toBe(600_000);
  });

  it("returns null for historical records without timestamps", () => {
    expect(runDurationMs({ status: "succeeded", startedAt: null, finishedAt: null })).toBeNull();
    expect(runDurationMs({ status: "succeeded", startedAt, finishedAt: null })).toBeNull();
    expect(runDurationMs({ status: "queued", startedAt: null })).toBeNull();
  });

  it("never returns a negative duration", () => {
    expect(runDurationMs({ status: "succeeded", startedAt: finishedAt, finishedAt: startedAt })).toBeNull();
  });
});

describe("DTO mapping", () => {
  it("maps a run without exposing internal or sensitive fields", () => {
    const summary = toAuditRunSummary(runRow({ runId: "run_1", startedAt: new Date("2026-08-10T10:00:00.000Z"), finishedAt: new Date("2026-08-10T10:05:00.000Z") }) as never, "Brief 工作区", { toolCount: 3, failedToolCount: 1 });
    expect(summary).toMatchObject({
      id: "run_1",
      workspaceId: "ws_1",
      workspaceName: "Brief 工作区",
      mode: "plan",
      status: "succeeded",
      durationMs: 300_000,
      toolCount: 3,
      failedToolCount: 1,
    });
    for (const key of Object.keys(summary)) {
      expect(["_id", "leaseOwner", "activeWorkspaceKey", "nextEventSequence", "persistedEventBytes", "budget", "sessionId"]).not.toContain(key);
    }
  });

  it("maps a tool call DTO with toolCallId and no raw output", () => {
    const tool = toAuditToolCall(toolRow() as never);
    expect(tool.toolCallId).toBe("call_1");
    expect(tool).not.toHaveProperty("_id");
    expect(tool).not.toHaveProperty("raw");
    expect(tool).toHaveProperty("requestedAt");
  });

  it("maps an artifact DTO with artifactId and toolCallId", () => {
    const artifact = toAuditArtifact(artifactRow() as never);
    expect(artifact.artifactId).toBe("artifact_1");
    expect(artifact.toolCallId).toBe("call_1");
    expect(artifact.payload).toEqual({ content: "hello" });
    expect(artifact).not.toHaveProperty("_id");
  });

  it("coerces a non-object artifact payload to an empty object", () => {
    expect(toAuditArtifact(artifactRow({ payload: "raw string" }) as never).payload).toEqual({});
  });
});

describe("listRunAudit", () => {
  beforeEach(() => {
    store.workspaces = [
      { workspaceId: "ws_1", userId: "user_1", name: "Brief 工作区" },
      { workspaceId: "ws_2", userId: "user_2", name: "他人工作区" },
    ];
  });

  it("scopes to the current user and joins workspace names", async () => {
    store.taskRuns = [
      runRow({ runId: "run_1", userId: "user_1", workspaceId: "ws_1", status: "succeeded" }),
      runRow({ runId: "run_2", userId: "user_2", workspaceId: "ws_2", status: "failed" }),
    ];
    store.toolCalls = [
      toolRow({ runId: "run_1", status: "completed" }),
      toolRow({ toolCallId: "call_2", runId: "run_1", status: "failed" }),
      toolRow({ toolCallId: "call_3", runId: "run_2", status: "completed" }),
    ];
    const result = await listRunAudit({ userId: "user_1", params: params() });
    expect(result).not.toBeNull();
    expect(result?.runs).toHaveLength(1);
    expect(result?.runs[0]).toMatchObject({ id: "run_1", workspaceName: "Brief 工作区", toolCount: 2, failedToolCount: 1 });
  });

  it("returns null when the workspace filter belongs to another user", async () => {
    store.taskRuns = [runRow({ runId: "run_1" })];
    expect(await listRunAudit({ userId: "user_1", params: params({ workspaceId: "ws_2" }) })).toBeNull();
  });

  it("excludes runs outside the time range", async () => {
    const realNow = Date.now();
    store.taskRuns = [
      runRow({ runId: "run_new", createdAt: new Date(realNow - 60_000) }),
      runRow({ runId: "run_old", createdAt: new Date(realNow - 8 * 24 * 60 * 60 * 1000) }),
    ];
    const result = await listRunAudit({ userId: "user_1", params: params({ range: "7d" }) });
    expect(result?.runs.map((run) => run.id)).toEqual(["run_new"]);
  });

  it("filters by status when requested", async () => {
    store.taskRuns = [
      runRow({ runId: "run_ok", status: "succeeded" }),
      runRow({ runId: "run_bad", status: "failed" }),
    ];
    const result = await listRunAudit({ userId: "user_1", params: params({ status: "failed" }) });
    expect(result?.runs.map((run) => run.id)).toEqual(["run_bad"]);
  });

  it("paginates by (createdAt, runId) without duplicates or skips", async () => {
    const t = new Date("2026-08-10T10:00:00.000Z");
    store.taskRuns = [
      runRow({ runId: "run_a", createdAt: t, updatedAt: t }),
      runRow({ runId: "run_b", createdAt: t, updatedAt: t }),
      runRow({ runId: "run_c", createdAt: new Date(t.getTime() - 3_600_000) }),
      runRow({ runId: "run_d", createdAt: new Date(t.getTime() - 7_200_000) }),
      runRow({ runId: "run_e", createdAt: new Date(t.getTime() - 10_800_000) }),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    for (;;) {
      const page = await listRunAudit({ userId: "user_1", params: params({ limit: 2, cursor: cursor ? decodeAuditCursor(cursor) : null }) });
      expect(page).not.toBeNull();
      for (const run of page!.runs) expect(seen).not.toContain(run.id);
      seen.push(...page!.runs.map((run) => run.id));
      pageCount += 1;
      if (!page!.nextCursor) break;
      cursor = page!.nextCursor;
    }
    // Descending (createdAt, runId): run_b and run_a share createdAt, run_b first.
    expect(seen).toEqual(["run_b", "run_a", "run_c", "run_d", "run_e"]);
    expect(pageCount).toBe(3);
  });
});

describe("getRunAuditDetail", () => {
  beforeEach(() => {
    store.workspaces = [{ workspaceId: "ws_1", userId: "user_1", name: "Brief 工作区" }];
  });

  it("does not return a run, tool calls or artifacts of another user", async () => {
    store.taskRuns = [runRow({ runId: "run_1", userId: "user_1" })];
    store.toolCalls = [toolRow({ runId: "run_1", userId: "user_1" })];
    store.artifacts = [artifactRow({ runId: "run_1", userId: "user_1" })];
    expect(await getRunAuditDetail("user_2", "run_1")).toBeNull();
  });

  it("returns the run with its tool timeline and artifacts for the owner", async () => {
    store.taskRuns = [runRow({ runId: "run_1", userId: "user_1", workspaceId: "ws_1", startedAt: new Date("2026-08-10T10:00:00.000Z"), finishedAt: new Date("2026-08-10T10:05:00.000Z") })];
    store.toolCalls = [
      toolRow({ toolCallId: "call_2", requestedAt: new Date("2026-08-10T10:00:02.000Z"), name: "search", status: "failed" }),
      toolRow({ toolCallId: "call_1", requestedAt: new Date("2026-08-10T10:00:01.000Z"), name: "read", status: "completed" }),
    ];
    store.artifacts = [artifactRow({ artifactId: "artifact_1", toolCallId: "call_1" })];
    const detail = await getRunAuditDetail("user_1", "run_1");
    expect(detail).not.toBeNull();
    expect(detail!.run.workspaceName).toBe("Brief 工作区");
    expect(detail!.run.toolCount).toBe(2);
    expect(detail!.run.failedToolCount).toBe(1);
    expect(detail!.run.durationMs).toBe(300_000);
    expect(detail!.toolCalls.map((tool) => tool.toolCallId)).toEqual(["call_1", "call_2"]);
    expect(detail!.artifacts).toHaveLength(1);
    expect(detail!.artifacts[0]).toMatchObject({ artifactId: "artifact_1", toolCallId: "call_1" });
  });
});
