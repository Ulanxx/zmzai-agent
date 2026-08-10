import { describe, expect, it } from "vitest";

import { mergeToolCallName } from "@/lib/relay-agent-stream";

describe("mergeToolCallName", () => {
  it("keeps a repeated full OpenAI-compatible tool name stable", () => {
    expect(mergeToolCallName("list", "list")).toBe("list");
  });

  it("accepts both full names and streamed name fragments", () => {
    expect(mergeToolCallName("", "li")).toBe("li");
    expect(mergeToolCallName("li", "st")).toBe("list");
    expect(mergeToolCallName("li", "list")).toBe("list");
  });
});
