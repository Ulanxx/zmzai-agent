import { afterEach, describe, expect, it, vi } from "vitest";

import { githubConnectorTools } from "@/lib/github-connector-tools";

afterEach(() => vi.unstubAllGlobals());

const input = { connectorId: "gh_demo", connectorName: "GitHub", headers: { authorization: "Bearer secret" } };

describe("githubConnectorTools", () => {
  it("exposes read-only tools with connector approval metadata", () => {
    const tools = githubConnectorTools(input);
    expect(tools.map((tool) => tool.id)).toEqual([
      "github_b7a5d14c_search_repositories",
      "github_b7a5d14c_get_repository",
      "github_b7a5d14c_list_issues",
      "github_b7a5d14c_read_file",
    ]);
    expect(tools.every((tool) => tool.permission?.({})?.permission === "connector")).toBe(true);
    expect(tools[0]?.permission?.({})?.metadata).toMatchObject({ connectorId: "gh_demo", readOnly: true });
  });

  it("encodes repository paths and returns bounded repository content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: "file", encoding: "base64", path: "src/main.ts", sha: "abc", size: 15, content: Buffer.from("export default 1").toString("base64") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = githubConnectorTools(input)[3]!;
    const result = await tool.execute({ owner: "acme", repository: "web-app", path: "src/main.ts", ref: "feature/x" }, {} as never);
    expect(result.output).toContain('"content": "export default 1"');
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/web-app/contents/src/main.ts?ref=feature%2Fx");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: "Bearer secret" } });
  });

  it("surfaces GitHub errors and refuses oversized responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })).mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-length": String(1024 * 1024 + 1) } })));
    const tools = githubConnectorTools(input);
    await expect(tools[1]!.execute({ owner: "acme", repository: "missing" }, {} as never)).rejects.toThrow("Not Found");
    await expect(tools[1]!.execute({ owner: "acme", repository: "too-large" }, {} as never)).rejects.toThrow("超过 1 MiB");
  });
});
