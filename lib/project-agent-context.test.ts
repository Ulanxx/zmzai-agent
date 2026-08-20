import { describe, expect, it } from "vitest";

import { combineAgentInstructions } from "@/lib/project-agent-context";

describe("project agent context", () => {
  it("combines workspace and project instructions in order", () => {
    expect(combineAgentInstructions(" workspace rule ", "project rule")).toBe("workspace rule\n\nproject rule");
  });

  it("does not create an empty prompt", () => {
    expect(combineAgentInstructions("  ", null)).toBeUndefined();
  });
});
