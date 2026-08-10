import { describe, expect, it } from "vitest";

import { createReadOnlyTools } from "@/lib/read-only-tool-broker";

describe("createReadOnlyTools", () => {
  it("exposes only the Workspace read capability set", () => {
    const tools = createReadOnlyTools({ userId: "user_1", workspaceId: "workspace_1" });

    expect(tools.map((tool) => tool.name)).toEqual(["list", "read", "search"]);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
  });

  it("declares bounded read and search arguments", () => {
    const tools = createReadOnlyTools({ userId: "user_1", workspaceId: "workspace_1" });
    const read = tools.find((tool) => tool.name === "read");
    const search = tools.find((tool) => tool.name === "search");

    expect(read?.parameters).toMatchObject({ type: "object", properties: { path: { maxLength: 512 } } });
    expect(search?.parameters).toMatchObject({ type: "object", properties: { query: { maxLength: 256 } } });
  });
});
