import { canonicalWorkspacePath } from "@/lib/workspace-path";

export const maxSessionUploadBytes = 512 * 1024;

export class SessionFileUploadError extends Error {
  constructor(public readonly code: "INVALID_PATH" | "TOO_LARGE" | "BINARY_FILE", message: string) {
    super(message);
    this.name = "SessionFileUploadError";
  }
}

export function uploadPath(input: { filename: string; requestedPath?: string | null }): string {
  const raw = input.requestedPath?.trim() || input.filename.trim();
  const valid = canonicalWorkspacePath(raw);
  if (!valid) throw new SessionFileUploadError("INVALID_PATH", "文件路径不合法或不允许上传到该位置");
  return valid;
}

export function decodeSessionUpload(bytes: Uint8Array): string {
  if (bytes.byteLength > maxSessionUploadBytes) {
    throw new SessionFileUploadError("TOO_LARGE", `文件不能超过 ${maxSessionUploadBytes / 1024} KB`);
  }
  if (bytes.includes(0)) throw new SessionFileUploadError("BINARY_FILE", "当前只支持文本、CSV、Markdown 和代码文件");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SessionFileUploadError("BINARY_FILE", "文件不是有效的 UTF-8 文本");
  }
}
