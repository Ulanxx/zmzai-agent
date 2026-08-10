import { describe, expect, it } from "vitest";

import { isRetryableRelayStatus, mergeToolCallName } from "@/lib/relay-agent-stream";

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

describe("isRetryableRelayStatus", () => {
  it("retries transient relay failures but not authorization or quota failures", () => {
    expect(isRetryableRelayStatus(500)).toBe(true);
    expect(isRetryableRelayStatus(503)).toBe(true);
    expect(isRetryableRelayStatus(401)).toBe(false);
    expect(isRetryableRelayStatus(402)).toBe(false);
  });
});
