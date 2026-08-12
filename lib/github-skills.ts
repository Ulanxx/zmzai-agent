import { basename } from "node:path";

/** Public GitHub-only importer. It never fetches a caller-provided host: the
 * repository name is validated, then every network target is constructed by us. */
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type ImportedGithubSkill = {
  repository: string;
  requestedRef: string;
  commitSha: string;
  path: string;
  name: string;
  description: string;
  markdown: string;
};

export function normalizeGithubSkillInput(input: { repository: string; ref?: string; path: string }): { repository: string; ref: string; path: string } | null {
  const repository = input.repository.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "");
  const ref = (input.ref?.trim() || "main");
  const path = input.path.trim().replace(/^\/+|\/+$/g, "");
  if (!REPOSITORY_RE.test(repository) || !ref || ref.length > 256 || !path || path.length > 500 || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  return { repository, ref, path: path.endsWith("SKILL.md") ? path.slice(0, -"SKILL.md".length).replace(/\/$/, "") : path };
}

function metadata(markdown: string, path: string): { name: string; description: string } {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
  const fromKey = (key: string) => new RegExp(`^${key}:\\s*[\\"']?(.+?)[\\"']?\\s*$`, "m").exec(frontmatter)?.[1]?.trim();
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return {
    name: fromKey("name") || heading || basename(path) || "GitHub Skill",
    description: fromKey("description") || "",
  };
}

export async function importGithubSkill(input: { repository: string; ref?: string; path: string }): Promise<ImportedGithubSkill> {
  const parsed = normalizeGithubSkillInput(input);
  if (!parsed) throw new Error("GitHub 仓库、ref 或 Skill 目录格式不正确");
  const commitResponse = await fetch(`https://api.github.com/repos/${parsed.repository}/commits/${encodeURIComponent(parsed.ref)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "zmzai-agent" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const commit = await commitResponse.json().catch(() => null) as { sha?: unknown; message?: unknown } | null;
  const commitSha = typeof commit?.sha === "string" ? commit.sha : "";
  if (!commitResponse.ok || !/^[0-9a-f]{40}$/.test(commitSha)) throw new Error(typeof commit?.message === "string" ? `无法解析 GitHub ref：${commit.message}` : "无法解析 GitHub ref");
  const skillPath = `${parsed.path ? `${parsed.path}/` : ""}SKILL.md`;
  // Keep content retrieval on api.github.com as well. Raw GitHub is a
  // different origin and is commonly blocked by enterprise egress rules.
  const markdownResponse = await fetch(`https://api.github.com/repos/${parsed.repository}/contents/${skillPath.split("/").map(encodeURIComponent).join("/")}?ref=${commitSha}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "zmzai-agent" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const content = await markdownResponse.json().catch(() => null) as { content?: unknown; encoding?: unknown } | null;
  if (!markdownResponse.ok) throw new Error(markdownResponse.status === 404 ? "该目录未找到 SKILL.md" : "无法读取 GitHub Skill");
  if (content?.encoding !== "base64" || typeof content.content !== "string") throw new Error("GitHub 未返回可读取的 SKILL.md 内容");
  const markdown = Buffer.from(content.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (!markdown.trim() || markdown.length > 256 * 1024) throw new Error("SKILL.md 为空或超过 256 KiB 限制");
  const details = metadata(markdown, parsed.path);
  return { repository: parsed.repository, requestedRef: parsed.ref, commitSha, path: parsed.path, markdown, ...details };
}
