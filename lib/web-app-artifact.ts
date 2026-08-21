import { createHash } from "node:crypto";

import { mongoEventLog } from "@/framework/core/events/mongo-event-log";
import { WorkspaceFileModel } from "@/models/workspace-file";
import { RunModel } from "@/models/run";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { artifactTitle, reserveArtifactVersion } from "@/lib/artifact-metadata";
import { storeArtifactBytes } from "@/lib/artifact-storage";
import { buildWebAppZip } from "@/lib/web-app-zip";

type WebAppSourceFile = { path: string; content: Buffer; contentType: string };

const webAppExtensions = new Map([
  ["html", "text/html"],
  ["css", "text/css"],
  ["js", "application/javascript"],
  ["mjs", "application/javascript"],
  ["json", "application/json"],
  ["svg", "image/svg+xml"],
]);

export function selectWebAppSourceFiles(files: Array<{ path: string; content: string }>): WebAppSourceFile[] {
  return files
    .filter((file) => file.path === "index.html" || webAppExtensions.has(file.path.split(".").pop()?.toLowerCase() ?? ""))
    .map((file) => ({
      path: file.path,
      content: Buffer.from(file.content, "utf8"),
      contentType: webAppExtensions.get(file.path.split(".").pop()?.toLowerCase() ?? "") ?? "application/octet-stream",
    }));
}

function artifactUrl(sessionId: string, artifactId: string, action: "download" | "preview"): string {
  return `/api/fw/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/${action}`;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function createArtifact(input: {
  userId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  path: string;
  content: Buffer;
  contentType: string;
  qualityStatus: "passed" | "failed";
}): Promise<{ artifactId: string; path: string; bytes: number; contentType: string; downloadUrl: string; previewUrl?: string } | null> {
  const digest = sha256(input.content);
  const existing = await SandboxArtifactModel.findOne({ runId: input.runId, sandboxPath: input.path, sha256: digest }).lean();
  if (existing) return null;
  const stored = await storeArtifactBytes({ content: input.content, contentType: input.contentType, filename: input.path.split("/").pop() ?? "artifact" });
  const artifactId = `art_${crypto.randomUUID()}`;
  const lineage = await reserveArtifactVersion({ userId: input.userId, runId: input.runId, path: input.path });
  await SandboxArtifactModel.create({
    artifactId,
    runId: input.runId,
    userId: input.userId,
    toolCallId: input.toolCallId,
    sandboxPath: input.path,
    title: artifactTitle(input.path),
    versionGroupId: lineage.versionGroupId,
    version: lineage.version,
    contentType: input.contentType,
    sizeBytes: input.content.length,
    sha256: digest,
    gridFsFileId: stored.fileId,
    tooLarge: false,
    qualityStatus: input.qualityStatus,
    qualityResult: null,
  });
  const previewable = input.contentType === "text/html" || input.contentType === "text/css" || input.contentType === "image/svg+xml";
  return {
    artifactId,
    path: input.path,
    bytes: input.content.length,
    contentType: input.contentType,
    downloadUrl: artifactUrl(input.sessionId, artifactId, "download"),
    ...(previewable ? { previewUrl: artifactUrl(input.sessionId, artifactId, "preview") } : {}),
  };
}

/** Materializes a web app written directly into the Workspace as the same
 * artifact family produced by Sandbox. The persisted framework events keep
 * the result visible after refresh and make the quality gate authoritative. */
export async function materializeWebAppArtifacts(input: {
  sessionId: string;
  entryPath: string;
  toolCallId: string;
  qualityStatus: "passed" | "failed";
}): Promise<void> {
  const run = await RunModel.findOne({ sessionId: input.sessionId }).sort({ createdAt: -1 }).lean();
  if (!run) return;
  const files = await WorkspaceFileModel.find({ workspaceId: run.workspaceId, sessionId: input.sessionId }).select({ path: 1, content: 1 }).sort({ path: 1 }).lean();
  const sourceFiles = selectWebAppSourceFiles(files);
  if (!sourceFiles.some((file) => file.path === input.entryPath)) return;
  const existingZip = await SandboxArtifactModel.findOne({ runId: run.runId, sandboxPath: "web_app.zip" }).lean();
  if (existingZip) return;

  const created = [];
  for (const file of sourceFiles) {
    const artifact = await createArtifact({ ...input, userId: run.userId, runId: run.runId, sessionId: input.sessionId, path: file.path, content: file.content, contentType: file.contentType });
    if (artifact) created.push(artifact);
  }
  const zip = await buildWebAppZip(sourceFiles);
  const zipArtifact = await createArtifact({ ...input, userId: run.userId, runId: run.runId, sessionId: input.sessionId, path: "web_app.zip", content: zip, contentType: "application/zip" });
  if (zipArtifact) created.push(zipArtifact);

  for (const artifact of created) {
    const event = await mongoEventLog.append({ sessionId: input.sessionId, type: "artifact.created", data: artifact });
    const { notifyEventLogListeners } = await import("@zmzai/agent-framework");
    notifyEventLogListeners(event);
  }
}
