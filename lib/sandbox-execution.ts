import { createHash, randomUUID } from "node:crypto";

import { maxRunArtifactTotalBytes, storeArtifactBytes } from "@/lib/artifact-storage";
import { AgentSandboxError, createAgentSandboxRun, getAgentSandboxRun, getAgentSandboxRunArtifact, getAgentSandboxRunArtifacts, streamAgentSandboxEvents, type SandboxRunStatus } from "@/lib/sandbox-client";
import type { SandboxCommand, SandboxLimits, SandboxSnapshot } from "@/lib/sandbox-types";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { buildWebAppZip, isWebAppArtifactSet } from "@/lib/web-app-zip";
import { artifactTitle, qualityStatusFor, reserveArtifactVersion } from "@/lib/artifact-metadata";

const maxArtifactBytes = 64 * 1024;

export type SandboxCommandRunResult = {
  ok: boolean;
  outcome: "succeeded" | "failed" | "unknown";
  exitCode: number | null;
  outputText: string;
  durationMs: number;
  sandboxRunId: string | null;
  errorMessage: string | null;
  artifacts: Array<{ path: string; bytes: number; contentType: string; sha256: string; tooLarge: boolean; artifactId?: string; workspaceContent?: string }>;
};

const syncableArtifactExtensions = new Set(["csv", "css", "html", "js", "json", "jsx", "md", "mjs", "ts", "tsx", "txt", "xml", "yaml", "yml"]);

function workspaceContentFor(path: string, content: Buffer): string | undefined {
  if (content.length > 512 * 1024) return undefined;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!syncableArtifactExtensions.has(extension)) return undefined;
  const text = content.toString("utf8");
  return Buffer.from(text, "utf8").equals(content) ? text : undefined;
}

export function classifySandboxOutcome(input: { status?: SandboxRunStatus | null; exitCode?: number | null } | null): SandboxCommandRunResult["outcome"] {
  if (!input) return "unknown";
  if (input.status !== "succeeded" && input.status !== "failed" && input.status !== "cancelled") return "unknown";
  return input.status === "succeeded" && (input.exitCode ?? 0) === 0 ? "succeeded" : "failed";
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An SSE connection can be interrupted while an OpenSandbox command keeps
 * running. Reconcile its durable run record before declaring the side effect
 * unknown, so a transient stream failure does not discard completed work. */
export async function waitForSandboxTerminalRun(runId: string, timeoutMs: number, pollIntervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  do {
    try {
      latest = await getAgentSandboxRun(runId);
      if (classifySandboxOutcome(latest) !== "unknown") return latest;
    } catch {
      // Keep polling until the command's declared deadline. The final read
      // below will preserve the unknown-side-effect safeguard if unavailable.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(pollIntervalMs, remaining));
  } while (Date.now() < deadline);
  return latest;
}

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

    try {
      await streamAgentSandboxEvents(created.id, (event) => {
        if (event.type === "sandbox.output" && event.text) pushOutput(event.text);
      });
    } catch {
      // The durable status record below is authoritative when the SSE
      // transport is interrupted or temporarily unavailable.
    }

    const final = await waitForSandboxTerminalRun(created.id, (input.limits?.timeoutMs ?? 60000) + 10_000);
    const outcome = classifySandboxOutcome(final);
    if (outcome === "unknown") return { ok: false, outcome, exitCode: final?.exitCode ?? null, outputText: outputParts.join(""), durationMs: Date.now() - startedAt, sandboxRunId: created.id, artifacts: [], errorMessage: "无法确认 Sandbox 命令的最终状态，请确认后再继续。" };
    const failed = outcome === "failed";
    const exitCode = final?.exitCode ?? (failed ? 1 : 0);
    const outputText = outputParts.join("");

    let artifacts: SandboxCommandRunResult["artifacts"] = [];
    if (!failed) {
      artifacts = await importDeliverables(input, created.id);
    }
    return { ok: !failed, outcome, exitCode, outputText, durationMs: Date.now() - startedAt, sandboxRunId: created.id, artifacts, errorMessage: failed ? `命令以退出码 ${exitCode} 结束` : null };
  } catch (error) {
    const message = error instanceof AgentSandboxError ? error.message : error instanceof Error ? error.message : "沙箱执行失败";
    return { ok: false, outcome: sandboxRunId ? "unknown" : "failed", exitCode: 1, outputText: outputParts.join(""), durationMs: Date.now() - startedAt, sandboxRunId, artifacts: [], errorMessage: sandboxRunId ? "无法确认 Sandbox 命令的最终状态，请确认后再继续。" : message };
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
    const lineage = await reserveArtifactVersion({ userId: input.userId, runId: input.runId, path: meta.path });
    await SandboxArtifactModel.create({
      artifactId,
      runId: input.runId,
      userId: input.userId,
      toolCallId: input.toolCallId,
      sandboxPath: meta.path,
      title: artifactTitle(meta.path),
      versionGroupId: lineage.versionGroupId,
      version: lineage.version,
      contentType: meta.contentType,
      sizeBytes: meta.bytes,
      sha256: meta.sha256,
      gridFsFileId: stored.fileId,
      tooLarge: false,
      qualityStatus: qualityStatusFor(meta.contentType, meta.path),
    }).catch(() => undefined);
    runTotal += meta.bytes;
    contents.push({ path: meta.path, content: fetched.content });
    const workspaceContent = workspaceContentFor(meta.path, fetched.content);
    imported.push({
      path: meta.path,
      bytes: meta.bytes,
      contentType: meta.contentType,
      sha256: meta.sha256,
      tooLarge: false,
      artifactId,
      ...(workspaceContent !== undefined ? { workspaceContent } : {}),
    });
  }

  if (isWebAppArtifactSet(contents) && runTotal < maxRunArtifactTotalBytes) {
    const zipContent = await buildWebAppZip(contents);
    if (runTotal + zipContent.length <= maxRunArtifactTotalBytes) {
      const stored = await storeArtifactBytes({ content: zipContent, contentType: "application/zip", filename: "web_app.zip" }).catch(() => null);
      if (stored) {
        const sha256 = createHash("sha256").update(zipContent).digest("hex");
        const artifactId = `art_${randomUUID()}`;
        const lineage = await reserveArtifactVersion({ userId: input.userId, runId: input.runId, path: "web_app.zip" });
        await SandboxArtifactModel.create({ artifactId, runId: input.runId, userId: input.userId, toolCallId: input.toolCallId, sandboxPath: "web_app.zip", title: artifactTitle("web_app.zip"), versionGroupId: lineage.versionGroupId, version: lineage.version, contentType: "application/zip", sizeBytes: zipContent.length, sha256, gridFsFileId: stored.fileId, tooLarge: false, qualityStatus: "pending" }).catch(() => undefined);
        imported.push({ path: "web_app.zip", bytes: zipContent.length, contentType: "application/zip", sha256, tooLarge: false, artifactId });
      }
    }
  }
  return imported;
}
