import { createHash } from "node:crypto";

import type { ToolDef } from "@zmzai/agent-framework";
import { z } from "zod";

const githubApi = "https://api.github.com";
const maxResponseBytes = 1024 * 1024;
const maxFileBytes = 512 * 1024;

type GithubConnectorInput = { connectorId: string; connectorName: string; headers: Record<string, string> };

function toolId(connectorId: string, action: string): string {
  return `github_${createHash("sha256").update(connectorId).digest("hex").slice(0, 8)}_${action}`;
}

function encodedPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function repositoryPath(owner: string, repository: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxResponseBytes) throw new Error("GitHub 响应超过 1 MiB 限制");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel();
      throw new Error("GitHub 响应超过 1 MiB 限制");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new Error("GitHub 返回了无效 JSON");
  }
}

async function githubRequest(input: GithubConnectorInput, path: string): Promise<unknown> {
  const response = await fetch(`${githubApi}${path}`, {
    headers: { accept: "application/vnd.github+json", ...input.headers },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await boundedJson(response);
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : `GitHub 返回 ${response.status}`;
    throw new Error(`GitHub 请求失败：${message.slice(0, 300)}`);
  }
  return body;
}

function output(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length > 120_000 ? `${serialized.slice(0, 120_000)}\n\n[结果已截断]` : serialized;
}

function permission(input: GithubConnectorInput, action: string) {
  return {
    permission: "connector" as const,
    patterns: [`${input.connectorName}/${action}`],
    always: [`${input.connectorName}/${action}`],
    metadata: { connectorId: input.connectorId, connectorName: input.connectorName, action: `GitHub ${action}`, readOnly: true },
  };
}

const ownerSchema = z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/, "GitHub owner 格式不正确");
const repositorySchema = z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/, "GitHub 仓库名格式不正确");
const filePathSchema = z.string().trim().min(1).max(500).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "文件路径不能包含上级目录");

/** Read-only GitHub capabilities. Each request still passes through the
 * framework's connector permission gate, so OAuth never becomes silent access. */
export function githubConnectorTools(input: GithubConnectorInput): ToolDef[] {
  return [
    {
      id: toolId(input.connectorId, "search_repositories"),
      label: `${input.connectorName} · 搜索仓库`,
      description: "在 GitHub 搜索可访问的仓库。",
      parameters: z.object({ query: z.string().trim().min(1).max(200), maxResults: z.number().int().min(1).max(20).default(10) }),
      permission: () => permission(input, "search repositories"),
      executionMode: "sequential",
      async execute(args) {
        const query = new URLSearchParams({ q: args.query, per_page: String(args.maxResults) });
        const body = await githubRequest(input, `/search/repositories?${query}`) as { total_count?: unknown; items?: unknown };
        const items = Array.isArray(body.items) ? body.items : [];
        return { title: `${input.connectorName} · 搜索仓库`, output: output({ total: typeof body.total_count === "number" ? body.total_count : items.length, repositories: items.map((item) => item && typeof item === "object" ? { name: item.full_name, description: item.description, url: item.html_url, stars: item.stargazers_count, updatedAt: item.updated_at, private: item.private } : item) }), metadata: { connectorId: input.connectorId, action: "search repositories", readOnly: true } };
      },
    },
    {
      id: toolId(input.connectorId, "get_repository"),
      label: `${input.connectorName} · 查看仓库`,
      description: "读取 GitHub 仓库的基本信息。",
      parameters: z.object({ owner: ownerSchema, repository: repositorySchema }),
      permission: () => permission(input, "get repository"),
      executionMode: "sequential",
      async execute(args) {
        const body = await githubRequest(input, repositoryPath(args.owner, args.repository)) as Record<string, unknown>;
        return { title: `${input.connectorName} · 查看仓库`, output: output({ name: body.full_name, description: body.description, url: body.html_url, defaultBranch: body.default_branch, visibility: body.visibility, stars: body.stargazers_count, forks: body.forks_count, openIssues: body.open_issues_count, updatedAt: body.updated_at, language: body.language, topics: body.topics }), metadata: { connectorId: input.connectorId, action: "get repository", readOnly: true } };
      },
    },
    {
      id: toolId(input.connectorId, "list_issues"),
      label: `${input.connectorName} · 列出议题`,
      description: "读取 GitHub 仓库的 issues（包含 Pull Request 标记）。",
      parameters: z.object({ owner: ownerSchema, repository: repositorySchema, state: z.enum(["open", "closed", "all"]).default("open"), maxResults: z.number().int().min(1).max(30).default(20) }),
      permission: () => permission(input, "list issues"),
      executionMode: "sequential",
      async execute(args) {
        const query = new URLSearchParams({ state: args.state, per_page: String(args.maxResults) });
        const body = await githubRequest(input, `${repositoryPath(args.owner, args.repository)}/issues?${query}`);
        const issues = Array.isArray(body) ? body : [];
        return { title: `${input.connectorName} · 列出议题`, output: output({ issues: issues.map((item) => item && typeof item === "object" ? { number: item.number, title: item.title, state: item.state, url: item.html_url, author: item.user && typeof item.user === "object" ? item.user.login : undefined, labels: Array.isArray(item.labels) ? item.labels.map((label: unknown) => label && typeof label === "object" && "name" in label ? label.name : label) : [], updatedAt: item.updated_at, isPullRequest: Boolean(item.pull_request) } : item) }), metadata: { connectorId: input.connectorId, action: "list issues", readOnly: true } };
      },
    },
    {
      id: toolId(input.connectorId, "read_file"),
      label: `${input.connectorName} · 读取文件`,
      description: "读取 GitHub 仓库中的 UTF-8 文本文件，单个文件最大 512 KiB。",
      parameters: z.object({ owner: ownerSchema, repository: repositorySchema, path: filePathSchema, ref: z.string().trim().min(1).max(200).optional() }),
      permission: () => permission(input, "read file"),
      executionMode: "sequential",
      async execute(args) {
        const query = args.ref ? `?${new URLSearchParams({ ref: args.ref })}` : "";
        const body = await githubRequest(input, `${repositoryPath(args.owner, args.repository)}/contents/${encodedPath(args.path)}${query}`) as Record<string, unknown>;
        if (body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") throw new Error("GitHub 返回的不是可读取文件");
        const content = Buffer.from(body.content.replace(/\s/g, ""), "base64");
        if (content.byteLength > maxFileBytes) throw new Error("GitHub 文件超过 512 KiB 限制");
        return { title: `${input.connectorName} · 读取文件`, output: output({ path: body.path, sha: body.sha, size: body.size, content: content.toString("utf8") }), metadata: { connectorId: input.connectorId, action: "read file", readOnly: true } };
      },
    },
  ];
}
