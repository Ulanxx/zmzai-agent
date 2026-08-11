import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { consumeExecutionGrant, getActiveExecutionGrant } from "@/lib/execution-grants";
import { createPendingExecution } from "@/lib/execution-proposals";
import { runSandboxCommandAndStream } from "@/lib/sandbox-execution";
import { buildExecSnapshot, SnapshotError } from "@/lib/sandbox-snapshot";

const defaultAllowedPrograms = ["node", "npm", "npx", "python3", "bash", "sh", "git", "ls", "cat", "grep", "find", "mkdir", "cp", "mv", "rm", "echo", "printf", "unzip", "tar", "curl", "wget", "env"];

function allowedPrograms(): Set<string> {
  const configured = process.env.EXEC_ALLOWED_PROGRAMS?.trim();
  if (!configured) return new Set(defaultAllowedPrograms);
  return new Set(configured.split(",").map((item) => item.trim()).filter(Boolean));
}

const execParameters = Type.Object({
  program: Type.String({ minLength: 1, maxLength: 64 }),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 })),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  env: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 2048 }), { maxProperties: 8 })),
});

function failure(message: string, program: string): never {
  throw new Error(`${program} 执行失败：${message}`);
}

function commandLabel(program: string, args: string[]): string {
  return [program, ...args].join(" ");
}

/**
 * The `exec` tool (build mode only). With a task-level execution grant the
 * command runs directly in the Sandbox (one ToolCall + one Sandbox Run, fully
 * traced) and the real result returns to the model. Without a grant it stages
 * an execution proposal and stops the loop for user approval.
 */
export function createExecTools(input: { userId: string; workspaceId: string; runId: string }): AgentTool[] {
  const exec: AgentTool<typeof execParameters> = {
    name: "exec",
    label: "在沙箱中执行命令",
    description: "在当前 Workspace 的影子快照（含未批准的提案变更）中执行一条命令。已获任务级执行授权时直接运行并返回结果；否则生成执行提案等待用户批准，批准后 stdout/stderr 会实时返回，生成的产物文件可下载。",
    parameters: execParameters,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const program = params.program.trim();
      if (!allowedPrograms().has(program)) return failure(`程序 "${program}" 不在允许列表`, program);
      const args = params.args ?? [];
      const label = commandLabel(program, args);

      const grant = await getActiveExecutionGrant({ userId: input.userId, runId: input.runId });

      if (grant) {
        let built;
        try {
          built = await buildExecSnapshot({ userId: input.userId, workspaceId: input.workspaceId, runId: input.runId });
        } catch (error) {
          return failure(error instanceof SnapshotError ? error.message : "影子快照构建失败", program);
        }
        const result = await runSandboxCommandAndStream({
          userId: input.userId,
          runId: input.runId,
          workspaceId: input.workspaceId,
          toolCallId,
          snapshot: built.snapshot,
          command: { program, args, ...(params.cwd ? { cwd: params.cwd } : {}), ...(Object.keys(params.env ?? {}).length ? { envs: params.env } : {}) },
        });
        await consumeExecutionGrant({ grantId: grant.id, durationMs: result.durationMs }).catch(() => undefined);
        const artifactLine = result.artifacts.length ? `；已交付产物：${result.artifacts.map((item) => `${item.path}（${item.bytes} B）`).join("、")}` : "";
        const exitLine = result.ok ? `退出码 0` : `退出码 ${result.exitCode}`;
        return {
          content: [{ type: "text", text: `${label} 执行完成（${exitLine}）${artifactLine}。输出已在上方画布。` }],
          details: { granted: true, exitCode: result.exitCode, artifacts: result.artifacts },
        };
      }

      // No grant: stage an execution proposal and stop the loop for approval.
      let built;
      try {
        built = await buildExecSnapshot({ userId: input.userId, workspaceId: input.workspaceId, runId: input.runId });
      } catch (error) {
        return failure(error instanceof SnapshotError ? error.message : "影子快照构建失败", program);
      }
      try {
        const proposal = await createPendingExecution({
          userId: input.userId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          toolCallId,
          program,
          args,
          cwd: params.cwd ?? null,
          env: params.env ?? {},
          snapshotSummary: built.summary,
        });
        return {
          content: [{ type: "text", text: `已请求执行 ${label}，等待用户批准（影子快照 ${built.summary.fileCount} 个文件，共 ${built.summary.totalBytes} B）。批准后输出会返回。` }],
          details: { pendingApproval: true, proposalId: proposal.id, program, args, snapshotSummary: built.summary },
          terminate: true,
        };
      } catch (error) {
        return failure(error instanceof Error && error.message === "EXEC_ALREADY_PENDING" ? "已有待审批的执行请求，请先处理" : "执行提案创建失败", program);
      }
    },
  };
  return [exec];
}
