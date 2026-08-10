import { ArtifactReferenceModel } from "@/models/artifact-reference";
import { TaskRunModel, activeRunStates, taskRunStates } from "@/models/task-run";
import { ToolCallModel } from "@/models/tool-call";
import { WorkspaceModel } from "@/models/workspace";

/**
 * Cross-Workspace run audit boundary: parameter normalization, ownership
 * scoping, cursor pagination and DTO mapping for the /audit pages. All queries
 * are anchored on `userId`; no raw _id, lease, budget or sensitive payload is
 * ever exposed to the client.
 */

export type AuditRange = "24h" | "7d" | "30d";

const AUDIT_RANGE_MS: Record<AuditRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

export type AuditCursor = { createdAt: Date; runId: string };

export type AuditListParams = {
  range: AuditRange;
  workspaceId: string | null;
  status: string | null;
  cursor: AuditCursor | null;
  limit: number;
};

export type AuditRunSummary = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  mode: "plan" | "build";
  model: string;
  prompt: string;
  status: string;
  failureCode: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  toolCount: number;
  failedToolCount: number;
};

export type AuditToolCall = {
  toolCallId: string;
  name: string;
  status: "requested" | "running" | "completed" | "failed";
  argsSummary: string;
  label: string;
  resultSummary: { text: string; truncated: boolean; omittedBytes: number } | null;
  durationMs: number | null;
  requestedAt: string;
  completedAt: string | null;
};

export type AuditArtifact = {
  artifactId: string;
  toolCallId: string | null;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  payloadBytes: number;
  truncated: boolean;
  omittedBytes: number;
  createdAt: string;
};

export type AuditRunDetail = {
  run: AuditRunSummary;
  toolCalls: AuditToolCall[];
  artifacts: AuditArtifact[];
};

export type AuditListResult = { runs: AuditRunSummary[]; nextCursor: string | null };

type RunRecordShape = {
  runId: string;
  workspaceId: string;
  mode: "plan" | "build";
  model: string;
  prompt: string;
  status: string;
  failureCode?: string | null;
  cancelRequestedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

type ToolCallRecordShape = {
  toolCallId: string;
  name: string;
  status: "requested" | "running" | "completed" | "failed";
  argsSummary: string;
  label?: string;
  resultSummary?: { text: string; truncated: boolean; omittedBytes: number } | null;
  durationMs?: number | null;
  requestedAt: Date;
  completedAt?: Date | null;
};

type ArtifactRecordShape = {
  artifactId: string;
  toolCallId?: string | null;
  kind: string;
  title: string;
  payload: unknown;
  payloadBytes: number;
  truncated: boolean;
  omittedBytes: number;
  createdAt: Date;
};

const CURSOR_PREFIX = "v1.";

export function encodeAuditCursor(cursor: AuditCursor): string {
  const payload = Buffer.from(JSON.stringify({ c: cursor.createdAt.toISOString(), r: cursor.runId }), "utf8").toString("base64url");
  return `${CURSOR_PREFIX}${payload}`;
}

export function decodeAuditCursor(value: string): AuditCursor | null {
  if (!value.startsWith(CURSOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as { c?: unknown; r?: unknown };
    if (typeof parsed.r !== "string" || typeof parsed.c !== "string") return null;
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, runId: parsed.r };
  } catch {
    return null;
  }
}

export function parseAuditListParams(searchParams: URLSearchParams): { ok: true; value: AuditListParams } | { ok: false } {
  const range = parseAuditRange(searchParams.get("range"));
  if (!range) return { ok: false };

  const workspaceId = searchParams.get("workspaceId");
  const status = searchParams.get("status");
  if (status !== null && status !== "" && !(taskRunStates as readonly string[]).includes(status)) return { ok: false };

  const cursorRaw = searchParams.get("cursor");
  const cursor = cursorRaw === null || cursorRaw === "" ? null : decodeAuditCursor(cursorRaw);
  if (cursorRaw !== null && cursorRaw !== "" && cursor === null) return { ok: false };

  let limit = DEFAULT_LIMIT;
  const limitRaw = searchParams.get("limit");
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isSafeInteger(parsed) || String(parsed) !== limitRaw.trim() || parsed < MIN_LIMIT || parsed > MAX_LIMIT) return { ok: false };
    limit = parsed;
  }

  return { ok: true, value: { range, workspaceId: workspaceId ? workspaceId : null, status: status ? status : null, cursor, limit } };
}

function parseAuditRange(value: string | null): AuditRange | null {
  if (value === null || value === "") return "7d";
  return value === "24h" || value === "7d" || value === "30d" ? value : null;
}

export function buildAuditRunFilter(input: { userId: string; params: AuditListParams }, now = Date.now()): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [
    { userId: input.userId },
    { createdAt: { $gte: new Date(now - AUDIT_RANGE_MS[input.params.range]) } },
  ];
  if (input.params.workspaceId) conditions.push({ workspaceId: input.params.workspaceId });
  if (input.params.status) conditions.push({ status: input.params.status });
  if (input.params.cursor) {
    // List is fixed to { createdAt: -1, runId: -1 }; continuation is strictly
    // after the cursor under that ordering and never includes the cursor row.
    conditions.push({
      $or: [
        { createdAt: { $lt: input.params.cursor.createdAt } },
        { createdAt: input.params.cursor.createdAt, runId: { $lt: input.params.cursor.runId } },
      ],
    });
  }
  return { $and: conditions };
}

/**
 * Run duration is defined only by execution timestamps: finishedAt - startedAt
 * for terminal runs, now - startedAt for active runs (waiting_approval included).
 * Historical records missing the timestamps return null — never a fallback.
 */
export function runDurationMs(run: { status: string; startedAt?: Date | string | null; finishedAt?: Date | string | null }, now = Date.now()): number | null {
  if (run.startedAt == null) return null;
  const startedAt = toEpochMs(run.startedAt);
  if (startedAt == null) return null;
  const finishedAt = run.finishedAt == null ? ((activeRunStates as readonly string[]).includes(run.status) ? now : null) : toEpochMs(run.finishedAt);
  if (finishedAt == null) return null;
  const durationMs = finishedAt - startedAt;
  return durationMs >= 0 ? durationMs : null;
}

function toEpochMs(value: Date | string): number | null {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function toAuditRunSummary(run: RunRecordShape, workspaceName: string, counts: { toolCount: number; failedToolCount: number }): AuditRunSummary {
  return {
    id: run.runId,
    workspaceId: run.workspaceId,
    workspaceName,
    mode: run.mode,
    model: run.model,
    prompt: run.prompt,
    status: run.status,
    failureCode: run.failureCode ?? null,
    cancelRequestedAt: isoString(run.cancelRequestedAt),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: isoString(run.startedAt),
    finishedAt: isoString(run.finishedAt),
    durationMs: runDurationMs(run),
    toolCount: counts.toolCount,
    failedToolCount: counts.failedToolCount,
  };
}

export function toAuditToolCall(tool: ToolCallRecordShape): AuditToolCall {
  return {
    toolCallId: tool.toolCallId,
    name: tool.name,
    status: tool.status,
    argsSummary: tool.argsSummary,
    label: tool.label ?? "",
    resultSummary: tool.resultSummary ?? null,
    durationMs: tool.durationMs ?? null,
    requestedAt: tool.requestedAt.toISOString(),
    completedAt: isoString(tool.completedAt),
  };
}

export function toAuditArtifact(artifact: ArtifactRecordShape): AuditArtifact {
  const payload = artifact.payload && typeof artifact.payload === "object" && !Array.isArray(artifact.payload) ? artifact.payload as Record<string, unknown> : {};
  return {
    artifactId: artifact.artifactId,
    toolCallId: artifact.toolCallId ?? null,
    kind: artifact.kind,
    title: artifact.title,
    payload,
    payloadBytes: artifact.payloadBytes,
    truncated: artifact.truncated,
    omittedBytes: artifact.omittedBytes,
    createdAt: artifact.createdAt.toISOString(),
  };
}

function isoString(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function listRunAudit(input: { userId: string; params: AuditListParams }): Promise<AuditListResult | null> {
  if (input.params.workspaceId) {
    const owned = await WorkspaceModel.exists({ userId: input.userId, workspaceId: input.params.workspaceId });
    if (!owned) return null;
  }

  const runs = await TaskRunModel.find(buildAuditRunFilter(input)).sort({ createdAt: -1, runId: -1 }).limit(input.params.limit).lean();
  if (runs.length === 0) return { runs: [], nextCursor: null };

  const runIds = runs.map((run) => run.runId);
  const workspaceIds = [...new Set(runs.map((run) => run.workspaceId))];
  const [workspaces, counts] = await Promise.all([
    WorkspaceModel.find({ userId: input.userId, workspaceId: { $in: workspaceIds } }).lean(),
    ToolCallModel.aggregate<{ _id: string; toolCount: number; failedToolCount: number }>([
      { $match: { runId: { $in: runIds }, userId: input.userId } },
      { $group: { _id: "$runId", toolCount: { $sum: 1 }, failedToolCount: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } } } },
    ]),
  ]);

  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.name]));
  const countByRun = new Map(counts.map((count) => [count._id, { toolCount: count.toolCount, failedToolCount: count.failedToolCount }]));
  const auditRuns = runs.map((run) => toAuditRunSummary(run, workspaceNames.get(run.workspaceId) ?? "未命名 Workspace", countByRun.get(run.runId) ?? { toolCount: 0, failedToolCount: 0 }));

  const last = runs[runs.length - 1];
  const nextCursor = runs.length === input.params.limit ? encodeAuditCursor({ createdAt: last.createdAt, runId: last.runId }) : null;
  return { runs: auditRuns, nextCursor };
}

export async function getRunAuditDetail(userId: string, runId: string): Promise<AuditRunDetail | null> {
  const run = await TaskRunModel.findOne({ userId, runId }).lean();
  if (!run) return null;

  const [toolCalls, artifacts, workspace] = await Promise.all([
    ToolCallModel.find({ userId, runId }).sort({ requestedAt: 1 }).lean(),
    ArtifactReferenceModel.find({ userId, runId }).sort({ createdAt: 1 }).lean(),
    WorkspaceModel.findOne({ userId, workspaceId: run.workspaceId }).lean(),
  ]);
  return {
    run: toAuditRunSummary(run, workspace?.name ?? "未命名 Workspace", {
      toolCount: toolCalls.length,
      failedToolCount: toolCalls.filter((tool) => tool.status === "failed").length,
    }),
    toolCalls: toolCalls.map(toAuditToolCall),
    artifacts: artifacts.map(toAuditArtifact),
  };
}
