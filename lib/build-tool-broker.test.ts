import { describe, expect, it } from "vitest";

import { createBuildTools } from "@/lib/build-tool-broker";

describe("createBuildTools", () => {
  it("adds proposal-only write capabilities to the read capability set", () => {
    const tools = createBuildTools({ userId: "user_1", workspaceId: "workspace_1", runId: "run_1", baseRevisionId: null });

    expect(tools.map((tool) => tool.name)).toEqual(["list", "read", "search", "write", "edit"]);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
  });

  it("bounds write and edit payloads", () => {
    const tools = createBuildTools({ userId: "user_1", workspaceId: "workspace_1", runId: "run_1", baseRevisionId: null });
    const write = tools.find((tool) => tool.name === "write");
    const edit = tools.find((tool) => tool.name === "edit");

    expect(write?.parameters).toMatchObject({ type: "object", properties: { path: { maxLength: 512 }, content: { maxLength: 524288 } } });
    expect(edit?.parameters).toMatchObject({ type: "object", properties: { oldText: { minLength: 1 }, newText: { maxLength: 524288 } } });
  });
});
