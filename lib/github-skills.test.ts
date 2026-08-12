import { afterEach, describe, expect, it, vi } from "vitest";

import { importGithubSkill, normalizeGithubSkillInput } from "@/lib/github-skills";

afterEach(() => vi.unstubAllGlobals());

describe("normalizeGithubSkillInput", () => {
  it("accepts a GitHub repository and canonicalizes the SKILL.md directory", () => {
    expect(normalizeGithubSkillInput({ repository: "https://github.com/openai/skills/", path: "/skills/pdf/SKILL.md" })).toEqual({
      repository: "openai/skills",
      ref: "main",
      path: "skills/pdf",
    });
  });

  it("rejects traversal and arbitrary repository URLs", () => {
    expect(normalizeGithubSkillInput({ repository: "https://example.com/a/b", path: "skills/pdf" })).toBeNull();
    expect(normalizeGithubSkillInput({ repository: "openai/skills", path: "skills/../secret" })).toBeNull();
  });
});

describe("importGithubSkill", () => {
  it("pins a ref to its commit before reading the Skill through GitHub's API", async () => {
    const sha = "a".repeat(40);
    const markdown = "---\nname: pdf\ndescription: PDF work\n---\n# PDF\n";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(markdown).toString("base64") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(importGithubSkill({ repository: "openai/skills", ref: "main", path: "skills/pdf" })).resolves.toEqual({
      repository: "openai/skills",
      requestedRef: "main",
      commitSha: sha,
      path: "skills/pdf",
      name: "pdf",
      description: "PDF work",
      markdown,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/openai/skills/commits/main");
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`contents/skills/pdf/SKILL.md?ref=${sha}`);
  });

  it("explains a missing SKILL.md without exposing a fetched host", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "b".repeat(40) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    await expect(importGithubSkill({ repository: "openai/skills", path: "missing" })).rejects.toThrow("该目录未找到 SKILL.md");
  });
});
