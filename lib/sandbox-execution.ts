import { randomUUID } from "node:crypto";

import { maxRunArtifactTotalBytes, storeArtifactBytes } from "@/lib/artifact-storage";
import { AgentSandboxError, createAgentSandboxRun, getAgentSandboxRun, getAgentSandboxRunArtifact, getAgentSandboxRunArtifacts, streamAgentSandboxEvents } from "@/lib/sandbox-client";
import { appendTaskEvent } from "@/lib/task-events";
import type { SandboxCommand, SandboxLimits, SandboxSnapshot } from "@/lib/sandbox-types";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

const maxArtifactBytes = 64 * 1024;
const maxResultSummaryBytes = 4 * 1024;

export type SandboxCommandRunResult = {
  ok: boolean;
  exitCode: number | null;
  outputText: string;
  durationMs: number;
  sandboxRunId: string | null;
  errorMessage: string | null;
  artifacts: Array<{ path: string; bytes: number; contentType: string; sha256: string; tooLarge: boolean }>;
};

function truncateBytes(value: string, limit: number): { text: string; truncated: boolean; omittedBytes: number } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= limit) return { text: value, truncated: false, omittedBytes: 0 };
  let text = value;
  while (Buffer.byteLength(text, "utf8") > limit) text = text.slice(0, -1);
  return { text, truncated: true, omittedBytes: bytes - Buffer.byteLength(text, "utf8") };
}

function basename(path: string): string {
  return path.split("/").pop() ?? "artifact";
}

/**
 * Runs one sandbox command for the agent: streams `execution_output` events,
 * finishes the exec tool node with the real result, and imports any
 * deliverables the sandbox produced into GridFS (§11.4), emitting a
 * `binary_file` artifact per imported file.
 *
 * Used by both the approved-resume path (execution-resume) and the
 * task-granted direct-execution path (exec-tool-broker).
 */
export async function runSandboxCommandAndStream(input: {
  userId: string;
  runId: string;
  workspaceId: string;
  toolCallId: string;
  snapshot: SandboxSnapshot;
  command: SandboxCommand;
  limits?: SandboxLimits;
}): Promise<SandboxCommandRunResult> {
  const startedAt = Date.now();
  const commandLabel = [input.command.program, ...input.command.args].join(" ");

  const safeAppend = async (event: { type: string; data: Record<string, unknown> }) => {
    try {
      await appendTaskEvent({ runId: input.runId, userId: input.userId, ...event });
    } catch { /* budget guard: drop non-terminal events when over budget */ }
  };
  const emitToolEnd = async (failed: boolean, resultSummary: { text: string; truncated: boolean; omittedBytes: number }) => {
    try {
      await appendTaskEvent({ runId: input.runId, userId: input.userId, type: failed ? "tool.failed" : "tool.completed", data: { toolCallId: input.toolCallId, name: "exec", durationMs: Date.now() - startedAt, resultSummary } });
    } catch { /* budget exhausted */ }
  };

  await safeAppend({ type: "tool.progress", data: { toolCallId: input.toolCallId, name: "exec", label: "正在准备沙箱" } });
  await safeAppend({ type: "artifact.upsert", data: { artifactId: `artifact_${input.toolCallId}`, toolCallId: input.toolCallId, kind: "execution_output", title: commandLabel, payload: { content: "", truncated: false, omittedBytes: 0 } } });

  let sandboxRunId: string | null = null;
  const outputParts: string[] = [];
  let outputBytes = 0;
  const pushOutput = async (text: string) => {
    if (!text) return;
    const bytes = Buffer.byteLength(text, "utf8");
    const offset = outputBytes;
    if (outputBytes + bytes > maxArtifactBytes) {
      const room = maxArtifactBytes - outputBytes;
      if (room > 0) {
        const sliced = text.slice(0, Math.max(0, room));
        outputParts.push(sliced);
        outputBytes += Buffer.byteLength(sliced, "utf8");
        await safeAppend({ type: "artifact.append", data: { artifactId: `artifact_${input.toolCallId}`, offset, text: sliced, truncated: false, omittedBytes: 0 } });
      }
      await safeAppend({ type: "artifact.append", data: { artifactId: `artifact_${input.toolCallId}`, offset: outputBytes, text: "", truncated: true, omittedBytes: 0 } });
      return;
    }
    outputParts.push(text);
    outputBytes += bytes;
    await safeAppend({ type: "artifact.append", data: { artifactId: `artifact_${input.toolCallId}`, offset, text, truncated: false, omittedBytes: 0 } });
  };

  try {
    await safeAppend({ type: "tool.progress", data: { toolCallId: input.toolCallId, name: "exec", label: "沙箱执行中" } });
    const created = await createAgentSandboxRun({
      userId: input.userId,
      taskRunId: input.runId,
      requestId: `tool_${input.toolCallId}`,
      snapshot: input.snapshot,
      command: input.command,
      limits: input.limits ?? { timeoutMs: 60000, cpuMillis: 500, memoryMiB: 512 },
    });
    sandboxRunId = created.id;

    await streamAgentSandboxEvents(created.id, (event) => {
      if (event.type === "sandbox.output" && event.text) void pushOutput(event.text);
    });

    const final = await getAgentSandboxRun(created.id);
    const failed = final?.status === "failed" || final?.status === "cancelled" || (final?.exitCode ?? 0) !== 0;
    const exitCode = final?.exitCode ?? (failed ? 1 : 0);
    const outputText = outputParts.join("");
    const summary = truncateBytes(outputText.slice(-maxResultSummaryBytes * 2), maxResultSummaryBytes);
    await emitToolEnd(failed, summary);

    let artifacts: SandboxCommandRunResult["artifacts"] = [];
    if (!failed) {
      artifacts = await importDeliverables(input, created.id);
    }
    return { ok: !failed, exitCode, outputText, durationMs: Date.now() - startedAt, sandboxRunId: created.id, artifacts, errorMessage: failed ? `命令以退出码 ${exitCode} 结束` : null };
  } catch (error) {
    const message = error instanceof AgentSandboxError ? error.message : error instanceof Error ? error.message : "沙箱执行失败";
    await emitToolEnd(true, { text: message, truncated: false, omittedBytes: 0 });
    return { ok: false, exitCode: 1, outputText: outputParts.join(""), durationMs: Date.now() - startedAt, sandboxRunId, artifacts: [], errorMessage: message };
  }
}

/**
 * Imports the sandbox deliverables manifest into GridFS (per-run budget 100 MiB)
 * and emits a `binary_file` artifact per imported file. Bytes never enter the
 * task event stream — only metadata.
 */
async function importDeliverables(input: { userId: string; runId: string; toolCallId: string }, sandboxRunId: string): Promise<SandboxCommandRunResult["artifacts"]> {
  const manifest = await getAgentSandboxRunArtifacts(sandboxRunId).catch(() => []);
  if (!manifest.length) return [];

  let runTotal = await SandboxArtifactModel.aggregate<{ total: number }>([{ $match: { runId: input.runId } }, { $group: { _id: null, total: { $sum: "$sizeBytes" } } }]).then((rows) => rows[0]?.total ?? 0).catch(() => 0);
  const imported: SandboxCommandRunResult["artifacts"] = [];

  for (const meta of manifest) {
    if (meta.tooLarge) continue;
    if (runTotal + meta.bytes > maxRunArtifactTotalBytes) continue;
    const fetched = await getAgentSandboxRunArtifact(sandboxRunId, meta.path).catch(() => null);
    if (!fetched) continue;
    const stored = await storeArtifactBytes({ content: fetched.content, contentType: meta.contentType, filename: basename(meta.path) }).catch(() => null);
    if (!stored) continue;
    const artifactId = `art_${randomUUID()}`;
    await SandboxArtifactModel.create({
      artifactId,
      runId: input.runId,
      userId: input.userId,
      toolCallId: input.toolCallId,
      sandboxPath: meta.path,
      contentType: meta.contentType,
      sizeBytes: meta.bytes,
      sha256: meta.sha256,
      gridFsFileId: stored.fileId,
      tooLarge: false,
    }).catch(() => undefined);
    runTotal += meta.bytes;
    imported.push({ path: meta.path, bytes: meta.bytes, contentType: meta.contentType, sha256: meta.sha256, tooLarge: false });
    await appendTaskEvent({
      runId: input.runId,
      userId: input.userId,
      type: "artifact.upsert",
      data: {
        artifactId: `bin_${artifactId}`,
        toolCallId: input.toolCallId,
        kind: "binary_file",
        title: meta.path,
        payload: { path: meta.path, bytes: meta.bytes, contentType: meta.contentType, sha256: meta.sha256, downloadUrl: `/api/runs/${input.runId}/artifacts/${artifactId}/download` },
      },
    }).catch(() => undefined);
  }
  return imported;
}
