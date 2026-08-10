import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { createPendingExecution } from "@/lib/execution-proposals";
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

/**
 * The `exec` tool (build mode only): stages an execution proposal against the
 * run's shadow snapshot and stops the loop for user approval. The command only
 * ever runs in the Sandbox after the user approves — never on the agent host.
 */
export function createExecTools(input: { userId: string; workspaceId: string; runId: string }): AgentTool[] {
  const exec: AgentTool<typeof execParameters> = {
    name: "exec",
    label: "在沙箱中执行命令",
    description: "在当前 Workspace 的影子快照（含未批准的提案变更）中执行一条命令。命令不会立即运行：生成执行提案并等待用户批准，批准后 stdout/stderr 会实时返回。",
    parameters: execParameters,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const program = params.program.trim();
      if (!allowedPrograms().has(program)) return failure(`程序 "${program}" 不在允许列表`, program);
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
          args: params.args ?? [],
          cwd: params.cwd ?? null,
          env: params.env ?? {},
          snapshotSummary: built.summary,
        });
        const commandLabel = [program, ...(params.args ?? [])].join(" ");
        return {
          content: [{ type: "text", text: `已请求执行 ${commandLabel}，等待用户批准（影子快照 ${built.summary.fileCount} 个文件，共 ${built.summary.totalBytes} B）。批准后输出会返回。` }],
          details: { pendingApproval: true, proposalId: proposal.id, program, args: params.args ?? [], snapshotSummary: built.summary },
          terminate: true,
        };
      } catch (error) {
        return failure(error instanceof Error && error.message === "EXEC_ALREADY_PENDING" ? "已有待审批的执行请求，请先处理" : "执行提案创建失败", program);
      }
    },
  };
  return [exec];
}
