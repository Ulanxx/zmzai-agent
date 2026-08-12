import { afterEach, describe, expect, it, vi } from "vitest";

import { importGithubAgentPlugin, normalizeGithubPluginInput } from "@/lib/github-agent-plugins";

afterEach(() => vi.unstubAllGlobals());

describe("normalizeGithubPluginInput", () => {
  it("uses a repository root by default and rejects traversal", () => {
    expect(normalizeGithubPluginInput({ repository: "https://github.com/acme/reports/" })).toEqual({ repository: "acme/reports", ref: "main", path: "" });
    expect(normalizeGithubPluginInput({ repository: "acme/reports", path: "plugins/../reports" })).toBeNull();
  });
});

describe("importGithubAgentPlugin", () => {
  it("pins a GitHub commit and isolates an invalid MCP entry from valid Skills", async () => {
    const sha = "c".repeat(40);
    const content = (value: string) => JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(value).toString("base64") });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/commits/")) return Promise.resolve(new Response(JSON.stringify({ sha }), { status: 200 }));
      if (url.includes("/contents/skills?")) return Promise.resolve(new Response(JSON.stringify([{ name: "report", type: "dir" }]), { status: 200 }));
      if (url.includes("plugin.json")) return Promise.resolve(new Response(content(JSON.stringify({ name: "reports" })), { status: 200 }));
      if (url.includes("skills/report/SKILL.md")) return Promise.resolve(new Response(content("# Report"), { status: 200 }));
      if (url.includes("mcp.json")) return Promise.resolve(new Response(content(JSON.stringify({ mcpServers: { broken: { type: "stdio", command: "../escape" } } })), { status: 200 }));
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await importGithubAgentPlugin({ repository: "acme/reports" });
    expect(result).toMatchObject({ repository: "acme/reports", commitSha: sha, plugin: { manifest: { name: "reports" }, skills: [expect.objectContaining({ id: "reports/report" })] } });
    expect(result.plugin.mcpServers).toEqual({});
    expect(result.plugin.errors).toEqual(["MCP broken 的 stdio 配置无效"]);
  });
});
