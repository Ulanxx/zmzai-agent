import { getShadowFiles } from "@/lib/proposals";
import type { SandboxSnapshot } from "@/lib/sandbox-types";
import { WorkspaceModel } from "@/models/workspace";

const maxSnapshotFiles = 200;
const maxSnapshotBytes = 1024 * 1024;

export type ExecSnapshotSummary = { revisionId: string | null; fileCount: number; totalBytes: number; files: string[] };

export class SnapshotError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/**
 * Builds the shadow-view snapshot for an approved execution: the current
 * committed workspace state overlaid with this run's pending (uncommitted)
 * change proposals. This lets the user approve running code that includes
 * changes that have not been committed yet — test before commit.
 */
export async function buildExecSnapshot(input: { userId: string; workspaceId: string; runId: string }): Promise<{ snapshot: SandboxSnapshot; summary: ExecSnapshotSummary }> {
  const [files, workspace] = await Promise.all([
    getShadowFiles({ workspaceId: input.workspaceId, runId: input.runId }),
    WorkspaceModel.findOne({ workspaceId: input.workspaceId, userId: input.userId }).lean(),
  ]);
  if (files.length > maxSnapshotFiles) throw new SnapshotError("SNAPSHOT_TOO_LARGE", `快照文件数超过 ${maxSnapshotFiles} 限制，无法在沙箱中执行`);
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  if (totalBytes > maxSnapshotBytes) throw new SnapshotError("SNAPSHOT_TOO_LARGE", "快照总大小超过 1 MiB 限制，无法在沙箱中执行");
  return {
    snapshot: { revisionId: workspace?.currentRevisionId ?? null, files: files.map((file) => ({ path: file.path, content: file.content })) },
    summary: { revisionId: workspace?.currentRevisionId ?? null, fileCount: files.length, totalBytes, files: files.map((file) => file.path) },
  };
}
