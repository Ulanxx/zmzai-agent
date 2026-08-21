import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptConnectorHeaders } from "@/lib/connector-secrets";
import { generateOutboundWebhookSecret, outboundWebhookSignature } from "@/lib/outbound-webhooks";

const original = process.env.AUTH_SECRET;
beforeEach(() => { process.env.AUTH_SECRET = "a".repeat(32); });
afterEach(() => { if (original === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = original; });

describe("outbound webhooks", () => {
  it("generates an encrypted one-time secret and deterministic delivery signature", () => {
    const generated = generateOutboundWebhookSecret();
    expect(generated.plaintext).toMatch(/^whs_[A-Za-z0-9_-]{32,}$/);
    expect(generated.encrypted).not.toContain(generated.plaintext);
    expect(decryptConnectorHeaders(generated.encrypted).secret).toBe(generated.plaintext);
    expect(outboundWebhookSignature(generated.plaintext, "2026-08-20T10:00:00.000Z", "whd_1", "{\"ok\":true}")).toMatch(/^v1=[a-f0-9]{64}$/);
  });
});
