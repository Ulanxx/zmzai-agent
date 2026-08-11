import type { PermissionEngine } from "@/framework/core/permission/engine";
import type { SandboxSnapshot } from "@/lib/sandbox-types";

/** Workspace facade: the single seam between framework tools and the file
 *  backend. The cloud default is Mongo-backed (MongoWorkspaceFiles, §7.2);
 *  the local JSONL demo mode provides an FS-backed implementation later. */
export interface WorkspaceFiles {
  list(): Promise<{ path: string; bytes: number }[]>;
  read(path: string): Promise<{ path: string; content: string } | null>;
  /** Direct write with revision + diff. Returns null when the path is
   *  rejected by workspace path validation. */
  write(input: { path: string; content: string; author: "agent"; summary: string }): Promise<{ revisionId: string; diff: string } | null>;
  /** Direct edit (exact oldText → newText, unique occurrence). */
  edit(input: { path: string; oldText: string; newText: string; author: "agent"; summary: string }): Promise<{ revisionId: string; diff: string } | { error: string }>;
}

export type SandboxExecResult = {
  ok: boolean;
  exitCode: number | null;
  outputText: string;
  durationMs: number;
  artifacts: { path: string; bytes: number; contentType: string; downloadUrl: string; previewUrl?: string }[];
};

export type SandboxExecInput = {
  toolCallId: string;
  command: { program: string; args: string[]; cwd?: string; env?: Record<string, string> };
  snapshot: SandboxSnapshot;
  /** Streams raw sandbox output back (runner forwards it as tool metadata). */
  onOutput?: (chunk: string) => void;
};

export interface ToolContext {
  sessionId: string;
  userId: string;
  workspaceId: string;
  agent: string;
  abort: AbortSignal;
  /** Permission escalation from inside a tool (rare; prefer the declarative
   *  `permission` field on ToolDef, which the runner evaluates first). */
  ask: PermissionEngine["ask"];
  workspace: WorkspaceFiles;
  buildSnapshot(): Promise<SandboxSnapshot>;
  runSandbox(input: SandboxExecInput): Promise<SandboxExecResult>;
  /** Updates the live todo projection; emits todo.updated. */
  setTodos(todos: { content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority?: "high" | "medium" | "low" }[]): Promise<void>;
  /** Emits file.edited after a direct write/edit lands. */
  emitFileEdited(input: { path: string; revisionId: string; diff: string }): Promise<void>;
  /** Emits artifact.created for every sandbox deliverable. */
  emitArtifact(input: { artifactId: string; path: string; bytes: number; contentType: string; downloadUrl: string; previewUrl?: string }): Promise<void>;
}
