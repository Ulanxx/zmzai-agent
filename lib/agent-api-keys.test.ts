import { describe, expect, it } from "vitest";

import { generateAgentApiKey, hashAgentApiKey, parseBearerApiKey } from "@/lib/agent-api-keys";

describe("agent API keys", () => {
  it("generates a one-time high-entropy key and a non-plaintext hash", () => {
    const created = generateAgentApiKey();
    expect(created.plaintext).toMatch(/^zma_[A-Za-z0-9_-]{32,}$/);
    expect(created.prefix).toBe(created.plaintext.slice(0, 16));
    expect(created.keyHash).toBe(hashAgentApiKey(created.plaintext));
    expect(created.keyHash).not.toContain(created.plaintext);
  });

  it("accepts only a Bearer Agent API key", () => {
    const key = generateAgentApiKey().plaintext;
    expect(parseBearerApiKey(`Bearer ${key}`)).toBe(key);
    expect(parseBearerApiKey(key)).toBeNull();
    expect(parseBearerApiKey("Bearer zrk_not-an-agent-key")).toBeNull();
  });
});
