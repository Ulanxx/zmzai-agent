import { parseAgentPlugin, type ParsedAgentPlugin, type PluginFileSystem } from "@zmzai/agent-framework";

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type ImportedGithubAgentPlugin = {
  repository: string;
  requestedRef: string;
  commitSha: string;
  path: string;
  plugin: ParsedAgentPlugin;
};

export function normalizeGithubPluginInput(input: { repository: string; ref?: string; path?: string }): { repository: string; ref: string; path: string } | null {
  const repository = input.repository.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "");
  const ref = input.ref?.trim() || "main";
  const path = (input.path ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!REPOSITORY_RE.test(repository) || !ref || ref.length > 256 || path.length > 500 || (path && path.split("/").some((part) => !part || part === "." || part === ".."))) return null;
  return { repository, ref, path };
}

function contentsUrl(repository: string, path: string, ref: string): string {
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repository}/contents${encoded ? `/${encoded}` : ""}?ref=${encodeURIComponent(ref)}`;
}

async function githubJson(url: string): Promise<{ response: Response; json: unknown }> {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "zmzai-agent" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  return { response, json: await response.json().catch(() => null) };
}

function remotePath(root: string, localPath: string): string {
  const relative = localPath.replace(/^\/plugin\/?/, "");
  return [root, relative].filter(Boolean).join("/");
}

/** GitHub-backed PluginFileSystem. Only repository components are fetched;
 * parser paths are virtual, fixed below /plugin, so no external host or path
 * supplied by the caller is ever dereferenced. */
function githubFiles(input: { repository: string; commitSha: string; rootPath: string }): PluginFileSystem {
  return {
    async read(localPath) {
      const { response, json } = await githubJson(contentsUrl(input.repository, remotePath(input.rootPath, localPath), input.commitSha));
      if (!response.ok || !json || typeof json !== "object") return null;
      const value = json as { type?: unknown; encoding?: unknown; content?: unknown };
      if (value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string") return null;
      const markdown = Buffer.from(value.content.replace(/\s/g, ""), "base64").toString("utf8");
      return markdown.length <= 256 * 1024 ? markdown : null;
    },
    async list(localPath) {
      const { response, json } = await githubJson(contentsUrl(input.repository, remotePath(input.rootPath, localPath), input.commitSha));
      if (!response.ok || !Array.isArray(json)) return [];
      return json.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const entry = value as { name?: unknown; type?: unknown };
        if (typeof entry.name !== "string" || typeof entry.type !== "string") return [];
        return [{ path: `${localPath}/${entry.name}`, isDirectory: entry.type === "dir" }];
      });
    },
  };
}

export async function importGithubAgentPlugin(input: { repository: string; ref?: string; path?: string }): Promise<ImportedGithubAgentPlugin> {
  const parsed = normalizeGithubPluginInput(input);
  if (!parsed) throw new Error("GitHub 仓库、ref 或插件目录格式不正确");
  const { response, json } = await githubJson(`https://api.github.com/repos/${parsed.repository}/commits/${encodeURIComponent(parsed.ref)}`);
  const commit = json && typeof json === "object" ? json as { sha?: unknown; message?: unknown } : null;
  const commitSha = typeof commit?.sha === "string" ? commit.sha : "";
  if (!response.ok || !/^[0-9a-f]{40}$/.test(commitSha)) throw new Error(typeof commit?.message === "string" ? `无法解析 GitHub ref：${commit.message}` : "无法解析 GitHub ref");
  try {
    const plugin = await parseAgentPlugin({ root: "/plugin", files: githubFiles({ repository: parsed.repository, commitSha, rootPath: parsed.path }) });
    return { repository: parsed.repository, requestedRef: parsed.ref, commitSha, path: parsed.path, plugin };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "无法读取 Agent Plugin");
  }
}
