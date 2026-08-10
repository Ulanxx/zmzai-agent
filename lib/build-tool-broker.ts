import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { stageEditProposal, stageWriteProposal } from "@/lib/proposals";
import { createReadOnlyTools } from "@/lib/read-only-tool-broker";

type ToolDetails = { activity: string; path?: string; proposalId?: string };

function result(text: unknown, details: ToolDetails) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: text }) }], details };
}

function failure(message: string, details: ToolDetails): never {
  throw new Error(`${details.activity}: ${message}`);
}

const writeParameters = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 512 }),
  content: Type.String({ maxLength: 512 * 1024 }),
});
const editParameters = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 512 }),
  oldText: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
  newText: Type.String({ maxLength: 512 * 1024 }),
});

export function createBuildTools(input: { userId: string; workspaceId: string; runId: string; baseRevisionId: string | null }): AgentTool[] {
  const write: AgentTool = {
    name: "write",
    label: "生成文件提案",
    description: "在当前 Run 的暂存提案中创建或完整替换一个文本文件。不会直接修改 Workspace，必须等待用户批准。",
    parameters: writeParameters,
    executionMode: "sequential",
    async execute(_, params: unknown) {
      const value = params as { path: string; content: string };
      try {
        const proposal = await stageWriteProposal({ ...input, path: value.path, content: value.content });
        return result({ proposalId: proposal.proposalId, status: proposal.status, path: value.path }, { activity: "已生成文件变更提案", path: value.path, proposalId: proposal.proposalId });
      } catch (error) {
        return failure(error instanceof Error ? error.message : "无法生成文件提案", { activity: "生成文件提案", path: value.path });
      }
    },
  };

  const edit: AgentTool = {
    name: "edit",
    label: "生成编辑提案",
    description: "在当前 Run 的暂存视图中精确替换一段唯一文本。不会直接修改 Workspace，必须等待用户批准。",
    parameters: editParameters,
    executionMode: "sequential",
    async execute(_, params: unknown) {
      const value = params as { path: string; oldText: string; newText: string };
      try {
        const proposal = await stageEditProposal({ ...input, ...value });
        return result({ proposalId: proposal.proposalId, status: proposal.status, path: value.path }, { activity: "已生成编辑提案", path: value.path, proposalId: proposal.proposalId });
      } catch (error) {
        return failure(error instanceof Error ? error.message : "无法生成编辑提案", { activity: "生成编辑提案", path: value.path });
      }
    },
  };

  return [...createReadOnlyTools(input), write, edit];
}
