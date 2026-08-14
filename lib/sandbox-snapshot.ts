import type { SandboxSnapshot } from "@/lib/sandbox-types";
import { WorkspaceModel } from "@/models/workspace";
import { WorkspaceFileModel } from "@/models/workspace-file";

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
 * Builds the execution snapshot from the session's committed files (runId =
 * sessionId). Under the framework protocol every write lands immediately as
 * an immutable revision (auto mode), so the committed state IS the execution
 * state — there are no pending proposals to overlay. 会话级隔离：快照只同步
 * 当前会话的文件，同一 workspace 其他会话的文件不可见。
 */
export async function buildExecSnapshot(input: { userId: string; workspaceId: string; runId: string }): Promise<{ snapshot: SandboxSnapshot; summary: ExecSnapshotSummary }> {
  const [files, workspace] = await Promise.all([
    WorkspaceFileModel.find({ workspaceId: input.workspaceId, sessionId: input.runId }).sort({ path: 1 }).lean(),
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
