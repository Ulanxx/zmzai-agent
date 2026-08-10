/**
 * Contract types shared between the Agent runtime (a.zmzai.cloud) and the
 * Sandbox internal API (z.zmzai.cloud). Mirrors the frozen contract in
 * docs/reference/sandbox-agent-internal-api.md.
 */
export type SandboxSnapshotFile = { path: string; content: string };
export type SandboxSnapshot = { revisionId: string | null; files: SandboxSnapshotFile[] };
export type SandboxCommand = { program: string; args: string[]; cwd?: string; envs?: Record<string, string> };
export type SandboxLimits = { timeoutMs?: number; cpuMillis?: number; memoryMiB?: number };
