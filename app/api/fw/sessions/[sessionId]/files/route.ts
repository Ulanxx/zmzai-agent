import { NextResponse } from "next/server";
import { notifyEventLogListeners } from "@zmzai/agent-framework";

import { productEventLog } from "@/framework/core/events/product-event-log";
import { defaultStore } from "@/framework/core/runtime/runner";
import { createMongoWorkspaceFiles } from "@/framework/core/tools/mongo-workspace";
import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { decodeSessionUpload, SessionFileUploadError, uploadPath } from "@/lib/session-file-upload";
import { canRunProject, getSessionProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { sessionId } = await context.params;
  const session = await defaultStore.getSession(sessionId);
  const access = session?.userId === user.id ? null : session ? await getSessionProjectAccess(sessionId, user.id) : null;
  if (!session || (session.userId !== user.id && (!access || !canRunProject(access.role)))) return apiError("SESSION_NOT_FOUND", 404, "会话不存在或无权访问");

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return apiError("FILE_REQUIRED", 400, "请选择一个文件");

  try {
    const path = uploadPath({ filename: file.name, requestedPath: typeof form?.get("path") === "string" ? form.get("path") as string : null });
    const content = decodeSessionUpload(new Uint8Array(await file.arrayBuffer()));
    const result = await createMongoWorkspaceFiles({ userId: session.userId, workspaceId: session.workspaceId, sessionId }).write({
      path,
      content,
      author: "agent",
      summary: `用户上传 ${path}`,
    });
    if (!result) return apiError("INVALID_PATH", 400, "文件路径不合法");
    const event = await productEventLog.append({ sessionId, type: "file.edited", data: { path, revisionId: result.revisionId, diff: result.diff } });
    notifyEventLogListeners(event);
    return NextResponse.json({ file: { path, bytes: Buffer.byteLength(content, "utf8"), revisionId: result.revisionId } }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof SessionFileUploadError) {
      const status = error.code === "INVALID_PATH" ? 400 : 413;
      return apiError(error.code, status, error.message);
    }
    throw error;
  }
}
