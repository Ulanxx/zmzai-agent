import JSZip from "jszip";

export type WebAppFile = { path: string; content: Buffer };

export function isWebAppArtifactSet(files: Array<{ path: string }>): boolean {
  return files.some((file) => file.path === "index.html");
}

/** Creates the user-facing web_app deliverable from files already pulled
 * through the authenticated Sandbox artifact endpoint. */
export async function buildWebAppZip(files: WebAppFile[]): Promise<Buffer> {
  if (!isWebAppArtifactSet(files)) throw new Error("web_app 必须包含 index.html");
  const zip = new JSZip();
  for (const file of files) zip.file(file.path, file.content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
