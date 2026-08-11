import { randomUUID } from "node:crypto";

import type { WorkspaceFiles } from "@zmzai/agent-framework";
import { connectMongo } from "@/lib/database/mongodb";
import { applySingleEdit, createUnifiedDiff } from "@/lib/workspace-edit";
import { validatedWorkspacePath } from "@/lib/workspaces";
import { WorkspaceFileModel } from "@/models/workspace-file";
import { WorkspaceRevisionModel } from "@/models/workspace-revision";
import { WorkspaceModel } from "@/models/workspace";

/** Mongo-backed WorkspaceFiles (spec §7.2 cloud default). Writes land
 *  immediately as immutable WorkspaceRevisions — the "auto" behavior that
 *  replaces proposal staging when the session ruleset allows `edit`. Every
 *  mutation runs in a transaction: revision + file upsert + workspace
 *  currentRevisionId advance either all happen or none do. */

type Change = { path: string; operation: "create" | "update" | "delete"; before: string | null; after: string | null };

async function commitChange(input: { userId: string; workspaceId: string; change: Change; summary: string }): Promise<{ revisionId: string }> {
  const mongo = await connectMongo();
  const session = await mongo.startSession();
  const revisionId = `rev_${randomUUID()}`;
  try {
    await session.withTransaction(async () => {
      const workspaceBefore = await WorkspaceModel.findOne({ workspaceId: input.workspaceId, userId: input.userId }, { currentRevisionId: 1 }, { session }).lean();
      if (!workspaceBefore) throw new Error("WORKSPACE_NOT_FOUND");
      await WorkspaceRevisionModel.create(
        [
          {
            revisionId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            parentRevisionId: workspaceBefore.currentRevisionId ?? null,
            author: "agent",
            changes: [input.change],
            summary: input.summary.slice(0, 2_000),
          },
        ],
        { session },
      );
      if (input.change.after === null) {
        await WorkspaceFileModel.deleteOne({ workspaceId: input.workspaceId, path: input.change.path }, { session });
      } else {
        await WorkspaceFileModel.updateOne(
          { workspaceId: input.workspaceId, path: input.change.path },
          { $set: { content: input.change.after, revisionId } },
          { upsert: true, session },
        );
      }
      await WorkspaceModel.updateOne({ workspaceId: input.workspaceId, userId: input.userId }, { $set: { currentRevisionId: revisionId } }, { session });
    });
    return { revisionId };
  } finally {
    await session.endSession();
  }
}

export function createMongoWorkspaceFiles(input: { userId: string; workspaceId: string }): WorkspaceFiles {
  return {
    async list() {
      const files = await WorkspaceFileModel.find({ workspaceId: input.workspaceId }).sort({ path: 1 }).lean();
      return files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") }));
    },

    async read(path) {
      const valid = validatedWorkspacePath(path);
      if (!valid) return null;
      const file = await WorkspaceFileModel.findOne({ workspaceId: input.workspaceId, path: valid }).lean();
      return file ? { path: file.path, content: file.content } : null;
    },

    async write({ path, content, summary }) {
      const valid = validatedWorkspacePath(path);
      if (!valid) return null;
      const existing = await WorkspaceFileModel.findOne({ workspaceId: input.workspaceId, path: valid }).lean();
      const change: Change = { path: valid, operation: existing ? "update" : "create", before: existing?.content ?? null, after: content };
      const { revisionId } = await commitChange({ ...input, change, summary });
      return { revisionId, diff: createUnifiedDiff(change) };
    },

    async edit({ path, oldText, newText, summary }) {
      const valid = validatedWorkspacePath(path);
      if (!valid) return { error: `路径不合法：${path}` };
      const existing = await WorkspaceFileModel.findOne({ workspaceId: input.workspaceId, path: valid }).lean();
      if (!existing) return { error: `文件不存在：${valid}` };
      const applied = applySingleEdit(existing.content, oldText, newText);
      if ("error" in applied) return { error: applied.error };
      const change: Change = { path: valid, operation: "update", before: existing.content, after: applied.content };
      const { revisionId } = await commitChange({ ...input, change, summary });
      return { revisionId, diff: createUnifiedDiff(change) };
    },
  };
}
