import { NextResponse } from "next/server";

import { defaultStore } from "@/framework/core/runtime/runner";
import { apiError } from "@/lib/api-error";
import { findPublicTask } from "@/lib/public-task-access";
import { requireAgentApiKey } from "@/lib/public-api";
import { extractStructuredOutput, finalAssistantText } from "@/lib/structured-output";
import { RunModel } from "@/models/run";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";
import { TaskModel } from "@/models/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function date(value: Date | null | undefined): string | null { return value?.toISOString() ?? null; }

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const authorized = await requireAgentApiKey(request, "tasks:read");
  if ("response" in authorized) return authorized.response;
  const { taskId } = await context.params;
  const task = await findPublicTask(taskId, authorized.key);
  if (!task) return apiError("TASK_NOT_FOUND", 404, "任务不存在或无权访问");
  const run = await RunModel.findOne({ taskId }).sort({ createdAt: -1 }).lean();
  const messages = run ? await defaultStore.getMessages(run.sessionId) : [];
  const finalText = finalAssistantText(messages);
  let structuredOutput = task.structuredOutput ?? null;
  let outputContractError = task.outputContractError ?? null;
  if (task.outputSchema && run && ["succeeded", "failed", "cancelled"].includes(run.status)) {
    const extracted = extractStructuredOutput(finalText, task.outputSchema);
    structuredOutput = extracted.value;
    outputContractError = extracted.error;
    await TaskModel.updateOne({ taskId }, { $set: { structuredOutput, outputContractError } });
  }
  const artifacts = run ? await SandboxArtifactModel.find({ runId: run.runId }).sort({ createdAt: 1 }).lean() : [];
  return NextResponse.json({
    id: task.taskId,
    workspace_id: task.workspaceId,
    project_id: task.projectId,
    source: task.source ?? "chat",
    title: task.title,
    prompt: task.goal,
    status: task.status,
    created_at: date(task.createdAt),
    updated_at: date(task.updatedAt),
    run: run ? { id: run.runId, status: run.status, attempt: run.attempt, terminal_reason: run.terminalReason ?? null, started_at: date(run.startedAt), finished_at: date(run.finishedAt) } : null,
    output: finalText,
    structured_output: structuredOutput,
    output_contract_error: outputContractError,
    artifacts: artifacts.map((artifact) => ({ id: artifact.artifactId, title: artifact.title, content_type: artifact.contentType, bytes: artifact.sizeBytes, quality_status: artifact.qualityStatus, created_at: date(artifact.createdAt), url: `/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}` })),
  }, { headers: { "cache-control": "no-store" } });
}
