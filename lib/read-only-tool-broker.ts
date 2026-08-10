import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { getShadowFile, getShadowFiles } from "@/lib/proposals";
import { WorkspaceFileModel } from "@/models/workspace-file";

type ToolDetails = { activity: string; count?: number; path?: string };
const readParameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }) });
const searchParameters = Type.Object({ query: Type.String({ minLength: 1, maxLength: 256 }) });

function result(text: unknown, details: ToolDetails) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: text }) }], details };
}

function failure(message: string, details: ToolDetails): never {
  throw new Error(`${details.activity}: ${message}`);
}

export function createReadOnlyTools(input: { userId: string; workspaceId: string; runId?: string }): AgentTool[] {
  const list: AgentTool = {
    name: "list",
    label: "列出文件",
    description: "列出当前 Workspace 中允许读取的文本文件路径。",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute() {
      if (input.runId) {
        const files = await getShadowFiles({ workspaceId: input.workspaceId, runId: input.runId });
        return result(files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8"), revisionId: file.revisionId })), { activity: "已列出文件", count: files.length });
      }
      const files = await WorkspaceFileModel.find({ workspaceId: input.workspaceId }).select({ path: 1, updatedAt: 1, content: 1 }).sort({ path: 1 }).lean();
      return result(files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8"), updatedAt: file.updatedAt.toISOString() })), { activity: "已列出文件", count: files.length });
    },
  };

  const read: AgentTool = {
    name: "read",
    label: "读取文件",
    description: "读取当前 Workspace 中一个文本文件的内容。路径必须来自 list 或已知 Workspace 路径。",
    parameters: readParameters,
    executionMode: "sequential",
    async execute(_, params: unknown) {
      const path = (params as { path: string }).path;
      if (input.runId) {
        const file = await getShadowFile({ workspaceId: input.workspaceId, runId: input.runId, path });
        if (!file) return failure("文件不存在或不可读取", { activity: "读取文件", path });
        return result({ path: file.path, content: file.content, revisionId: file.revisionId }, { activity: "已读取文件", path: file.path });
      }
      const file = await WorkspaceFileModel.findOne({ workspaceId: input.workspaceId, path }).lean();
      if (!file) return failure("文件不存在或不可读取", { activity: "读取文件", path });
      return result({ path: file.path, content: file.content, revisionId: file.revisionId }, { activity: "已读取文件", path: file.path });
    },
  };

  const search: AgentTool = {
    name: "search",
    label: "搜索文件",
    description: "在当前 Workspace 的文本文件内容中搜索关键词，最多返回 50 条匹配。",
    parameters: searchParameters,
    executionMode: "sequential",
    async execute(_, params: unknown) {
      const query = (params as { query: string }).query;
      const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const files = input.runId
        ? await getShadowFiles({ workspaceId: input.workspaceId, runId: input.runId })
        : await WorkspaceFileModel.find({ workspaceId: input.workspaceId }).select({ path: 1, content: 1 }).sort({ path: 1 }).lean();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of files) {
        for (const [offset, line] of file.content.split("\n").entries()) {
          if (!expression.test(line)) continue;
          matches.push({ path: file.path, line: offset + 1, text: line.slice(0, 1_000) });
          expression.lastIndex = 0;
          if (matches.length >= 50) break;
        }
        if (matches.length >= 50) break;
      }
      return result({ query, matches }, { activity: "已搜索文件", count: matches.length });
    },
  };

  return [list, read, search];
}
