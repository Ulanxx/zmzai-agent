import { createHash, randomUUID } from "node:crypto";

import { maxRunArtifactTotalBytes, storeArtifactBytes } from "@/lib/artifact-storage";
import { AgentSandboxError, createAgentSandboxRun, getAgentSandboxRun, getAgentSandboxRunArtifact, getAgentSandboxRunArtifacts, streamAgentSandboxEvents } from "@/lib/sandbox-client";
import type { SandboxCommand, SandboxLimits, SandboxSnapshot } from "@/lib/sandbox-types";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { buildWebAppZip, isWebAppArtifactSet } from "@/lib/web-app-zip";

const maxArtifactBytes = 64 * 1024;

export type SandboxCommandRunResult = {
  ok: boolean;
  exitCode: number | null;
  outputText: string;
  durationMs: number;
  sandboxRunId: string | null;
  errorMessage: string | null;
  artifacts: Array<{ path: string; bytes: number; contentType: string; sha256: string; tooLarge: boolean; artifactId?: string }>;
};

function basename(path: string): string {
  return path.split("/").pop() ?? "artifact";
}

/**
 * Runs one sandbox command for the framework's bash tool: executes in the
 * isolated sandbox, captures stdout/stderr, and imports any deliverables into
 * GridFS. Returns the result to the caller — event/part projection is the
 * caller's job (the FW runner owns the tool part lifecycle), so this module
 * no longer writes to the legacy task-event log.
 */
export async function runSandboxCommandAndStream(input: {
  userId: string;
  runId: string;
  workspaceId: string;
  toolCallId: string;
  snapshot: SandboxSnapshot;
  command: SandboxCommand;
  limits?: SandboxLimits;
  /** Optional raw output tap (streamed sandbox stdout/stderr lines). */
  onOutput?: (text: string) => void;
}): Promise<SandboxCommandRunResult> {
  const startedAt = Date.now();

  let sandboxRunId: string | null = null;
  const outputParts: string[] = [];
  let outputBytes = 0;
  const pushOutput = (text: string) => {
    if (!text) return;
    // Execd delivers each stdout line as one event without the trailing
    // newline; restore it so the output reads as proper lines.
    const line = text.endsWith("\n") ? text : `${text}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (outputBytes + bytes > maxArtifactBytes) {
      const room = maxArtifactBytes - outputBytes;
      if (room > 0) {
        const sliced = line.slice(0, Math.max(0, room));
        outputParts.push(sliced);
        outputBytes += Buffer.byteLength(sliced, "utf8");
        input.onOutput?.(sliced);
      }
      return;
    }
    outputParts.push(line);
    outputBytes += bytes;
    input.onOutput?.(line);
  };

  try {
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
      if (event.type === "sandbox.output" && event.text) pushOutput(event.text);
    });

    const final = await getAgentSandboxRun(created.id);
    const failed = final?.status === "failed" || final?.status === "cancelled" || (final?.exitCode ?? 0) !== 0;
    const exitCode = final?.exitCode ?? (failed ? 1 : 0);
    const outputText = outputParts.join("");

    let artifacts: SandboxCommandRunResult["artifacts"] = [];
    if (!failed) {
      artifacts = await importDeliverables(input, created.id);
    }
    return { ok: !failed, exitCode, outputText, durationMs: Date.now() - startedAt, sandboxRunId: created.id, artifacts, errorMessage: failed ? `命令以退出码 ${exitCode} 结束` : null };
  } catch (error) {
    const message = error instanceof AgentSandboxError ? error.message : error instanceof Error ? error.message : "沙箱执行失败";
    return { ok: false, exitCode: 1, outputText: outputParts.join(""), durationMs: Date.now() - startedAt, sandboxRunId, artifacts: [], errorMessage: message };
  }
}

/**
 * Imports the sandbox deliverables manifest into GridFS (per-run budget
 * 100 MiB). Bytes never enter any event stream — only metadata is returned.
 * The caller (FW runner) emits artifact.created per imported file.
 */
async function importDeliverables(input: { userId: string; runId: string; toolCallId: string }, sandboxRunId: string): Promise<SandboxCommandRunResult["artifacts"]> {
  const manifest = await getAgentSandboxRunArtifacts(sandboxRunId).catch(() => []);
  if (!manifest.length) return [];

  let runTotal = await SandboxArtifactModel.aggregate<{ total: number }>([{ $match: { runId: input.runId } }, { $group: { _id: null, total: { $sum: "$sizeBytes" } } }]).then((rows) => rows[0]?.total ?? 0).catch(() => 0);
  const imported: SandboxCommandRunResult["artifacts"] = [];
  const contents: Array<{ path: string; content: Buffer }> = [];

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
    contents.push({ path: meta.path, content: fetched.content });
    imported.push({ path: meta.path, bytes: meta.bytes, contentType: meta.contentType, sha256: meta.sha256, tooLarge: false, artifactId });
  }

  if (isWebAppArtifactSet(contents) && runTotal < maxRunArtifactTotalBytes) {
    const zipContent = await buildWebAppZip(contents);
    if (runTotal + zipContent.length <= maxRunArtifactTotalBytes) {
      const stored = await storeArtifactBytes({ content: zipContent, contentType: "application/zip", filename: "web_app.zip" }).catch(() => null);
      if (stored) {
        const sha256 = createHash("sha256").update(zipContent).digest("hex");
        const artifactId = `art_${randomUUID()}`;
        await SandboxArtifactModel.create({ artifactId, runId: input.runId, userId: input.userId, toolCallId: input.toolCallId, sandboxPath: "web_app.zip", contentType: "application/zip", sizeBytes: zipContent.length, sha256, gridFsFileId: stored.fileId, tooLarge: false }).catch(() => undefined);
        imported.push({ path: "web_app.zip", bytes: zipContent.length, contentType: "application/zip", sha256, tooLarge: false, artifactId });
      }
    }
  }
  return imported;
}
