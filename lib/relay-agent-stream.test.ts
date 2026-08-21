import { describe, expect, it } from "vitest";

import { isRetryableRelayStatus, mergeToolCallName, parseToolCallArguments, relayReasoningEffort } from "@/lib/relay-agent-stream";

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

describe("parseToolCallArguments", () => {
  it("keeps a malformed stream payload intact for the tool repair layer", () => {
    expect(parseToolCallArguments('{"path":"index.html"')).toBe('{"path":"index.html"');
  });

  it("parses valid JSON without changing its shape", () => {
    expect(parseToolCallArguments('{"path":"index.html"}')).toEqual({ path: "index.html" });
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

describe("relayReasoningEffort", () => {
  it("maps the PI-only minimal level to Relay's lowest accepted level", () => {
    expect(relayReasoningEffort("minimal")).toBe("low");
    expect(relayReasoningEffort("high")).toBe("high");
    expect(relayReasoningEffort(undefined)).toBeUndefined();
  });
});
