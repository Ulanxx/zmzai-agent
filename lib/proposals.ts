import { randomUUID } from "node:crypto";

import { appendTaskEvent } from "@/lib/task-events";
import { canonicalWorkspacePath } from "@/lib/workspace-path";
import { ChangeProposalModel } from "@/models/change-proposal";
import { WorkspaceFileModel } from "@/models/workspace-file";

export type ProposedFileChange = {
  path: string;
  operation: "create" | "update" | "delete";
  before: string | null;
  after: string | null;
};

export type ShadowFile = { path: string; content: string; revisionId: string | null };

const maxFileBytes = 512 * 1024;
const maxWorkspaceBytes = 10 * 1024 * 1024;

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

function diffLines(prefix: string, value: string | null): string[] {
  if (value === null || value === "") return [];
  return value.split("\n").map((line) => `${prefix}${line}`);
}

export function createUnifiedDiff(change: ProposedFileChange): string {
  const beforeLabel = change.before === null ? "/dev/null" : `a/${change.path}`;
  const afterLabel = change.after === null ? "/dev/null" : `b/${change.path}`;
  return [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -1,${lineCount(change.before ?? "")} +1,${lineCount(change.after ?? "")} @@`,
    ...diffLines("-", change.before),
    ...diffLines("+", change.after),
  ].join("\n");
}

function applyChange(files: Map<string, ShadowFile>, change: Pick<ProposedFileChange, "path"> & { after?: string | null }): void {
  if (change.after == null) {
    files.delete(change.path);
    return;
  }
  files.set(change.path, { path: change.path, content: change.after, revisionId: null });
}

export async function getShadowFiles(input: { workspaceId: string; runId: string }): Promise<ShadowFile[]> {
  const [files, proposals] = await Promise.all([
    WorkspaceFileModel.find({ workspaceId: input.workspaceId }).sort({ path: 1 }).lean(),
    ChangeProposalModel.find({ runId: input.runId, workspaceId: input.workspaceId, status: "pending" }).sort({ createdAt: 1 }).lean(),
  ]);
  const shadow = new Map(files.map((file) => [file.path, { path: file.path, content: file.content, revisionId: file.revisionId ?? null }]));
  for (const proposal of proposals) for (const change of proposal.changes) applyChange(shadow, change);
  return [...shadow.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function getShadowFile(input: { workspaceId: string; runId: string; path: string }): Promise<ShadowFile | null> {
  return (await getShadowFiles(input)).find((file) => file.path === input.path) ?? null;
}

function validateCandidate(input: { path: string; content: string; current: ShadowFile | null }): { change: ProposedFileChange } | { error: string } {
  const path = canonicalWorkspacePath(input.path);
  if (!path) return { error: "PATH_NOT_ALLOWED" };
  if (Buffer.byteLength(input.content, "utf8") > maxFileBytes) return { error: "FILE_TOO_LARGE" };
  return {
    change: {
      path,
      operation: input.current ? "update" : "create",
      before: input.current?.content ?? null,
      after: input.content,
    },
  };
}

export function applySingleEdit(content: string, oldText: string, newText: string): { content: string } | { error: string } {
  if (!oldText) return { error: "EDIT_TARGET_REQUIRED" };
  const first = content.indexOf(oldText);
  if (first === -1) return { error: "EDIT_TARGET_NOT_FOUND" };
  if (content.indexOf(oldText, first + oldText.length) !== -1) return { error: "EDIT_TARGET_AMBIGUOUS" };
  return { content: `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}` };
}

export function mergeProposedChange(changes: ProposedFileChange[], candidate: ProposedFileChange): ProposedFileChange[] {
  const currentIndex = changes.findIndex((change) => change.path === candidate.path);
  if (currentIndex === -1) return [...changes, candidate];
  const current = changes[currentIndex];
  const merged: ProposedFileChange = {
    path: candidate.path,
    operation: current.before === null ? "create" : "update",
    before: current.before,
    after: candidate.after,
  };
  if (merged.before === merged.after) return changes.filter((_, index) => index !== currentIndex);
  return changes.map((change, index) => index === currentIndex ? merged : change);
}

async function assertWorkspaceBudget(input: { workspaceId: string; runId: string; change: ProposedFileChange }): Promise<boolean> {
  const files = await getShadowFiles({ workspaceId: input.workspaceId, runId: input.runId });
  const shadow = new Map(files.map((file) => [file.path, file]));
  applyChange(shadow, input.change);
  const bytes = [...shadow.values()].reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  return bytes <= maxWorkspaceBytes;
}

export async function createPendingProposal(input: { userId: string; workspaceId: string; runId: string; baseRevisionId: string | null; change: ProposedFileChange; summary: string }) {
  if (!(await assertWorkspaceBudget(input))) throw new Error("WORKSPACE_SIZE_LIMIT");
  const existing = await ChangeProposalModel.findOne({ runId: input.runId, workspaceId: input.workspaceId, status: "pending" }).sort({ createdAt: 1 });
  const changes = mergeProposedChange(existing?.changes.map((change) => ({
    path: change.path,
    operation: change.operation,
    before: change.before ?? null,
    after: change.after ?? null,
  })) ?? [], input.change);
  if (!changes.length) {
    if (existing) await ChangeProposalModel.updateOne({ _id: existing._id, status: "pending" }, { $set: { status: "superseded" } });
    throw new Error("NO_EFFECTIVE_CHANGE");
  }
  const summary = changes.length === 1 ? input.summary : `已生成 ${changes.length} 项文件变更`;
  const diff = changes.map(createUnifiedDiff).join("\n\n");
  const proposal = existing
    ? await ChangeProposalModel.findOneAndUpdate({ _id: existing._id, status: "pending" }, { $set: { changes, diff, summary } }, { new: true })
    : await ChangeProposalModel.create({
      proposalId: `prp_${randomUUID()}`,
      runId: input.runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      baseRevisionId: input.baseRevisionId,
      status: "pending",
      changes,
      diff,
      summary,
    });
  if (!proposal) throw new Error("PROPOSAL_UPDATE_CONFLICT");
  const eventType = existing ? "proposal.updated" : "proposal.created";
  await appendTaskEvent({ runId: input.runId, userId: input.userId, type: eventType, data: { proposalId: proposal.proposalId, summary: proposal.summary, files: changes.map((change) => change.path), changeCount: changes.length } });
  if (!existing) await appendTaskEvent({ runId: input.runId, userId: input.userId, type: "approval.required", data: { proposalId: proposal.proposalId, kind: "workspace_change" } });
  return proposal;
}

export async function stageWriteProposal(input: { userId: string; workspaceId: string; runId: string; baseRevisionId: string | null; path: string; content: string }) {
  const current = await getShadowFile(input);
  const candidate = validateCandidate({ path: input.path, content: input.content, current });
  if ("error" in candidate) throw new Error(candidate.error);
  return createPendingProposal({ ...input, change: candidate.change, summary: `${candidate.change.operation === "create" ? "创建" : "更新"} ${candidate.change.path}` });
}

export async function stageEditProposal(input: { userId: string; workspaceId: string; runId: string; baseRevisionId: string | null; path: string; oldText: string; newText: string }) {
  const path = canonicalWorkspacePath(input.path);
  if (!path) throw new Error("PATH_NOT_ALLOWED");
  const current = await getShadowFile({ workspaceId: input.workspaceId, runId: input.runId, path });
  if (!current) throw new Error("FILE_NOT_FOUND");
  const edited = applySingleEdit(current.content, input.oldText, input.newText);
  if ("error" in edited) throw new Error(edited.error);
  const candidate = validateCandidate({ path, content: edited.content, current });
  if ("error" in candidate) throw new Error(candidate.error);
  return createPendingProposal({ ...input, change: candidate.change, summary: `编辑 ${candidate.change.path}` });
}

export async function hasPendingProposals(runId: string): Promise<boolean> {
  return Boolean(await ChangeProposalModel.exists({ runId, status: "pending" }));
}
