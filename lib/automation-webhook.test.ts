import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateAutomationWebhookSecret, validateAutomationWebhook, webhookPayloadHash, webhookPayloadMatches, webhookSignature } from "@/lib/automation-webhook";

const original = process.env.AUTH_SECRET;

beforeEach(() => { process.env.AUTH_SECRET = "a".repeat(32); });
afterEach(() => { if (original === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = original; });

describe("automation webhook signatures", () => {
  it("treats an event id with different content as a conflict", () => {
    const body = '{"issue":"open"}';
    expect(webhookPayloadMatches(webhookPayloadHash(body), body)).toBe(true);
    expect(webhookPayloadMatches(webhookPayloadHash(body), '{"issue":"closed"}')).toBe(false);
    expect(webhookPayloadMatches(null, body)).toBe(false);
  });

  it("accepts a current HMAC-signed event", () => {
    const secret = generateAutomationWebhookSecret();
    const timestamp = "2026-08-20T10:00:00.000Z";
    const body = '{"issue":"open"}';
    expect(validateAutomationWebhook({ encryptedSecret: secret.encrypted, timestamp, eventId: "evt_1", signature: webhookSignature(secret.plaintext, timestamp, "evt_1", body), body, now: new Date(timestamp) })).toBeNull();
  });

  it("rejects tampering, stale timestamps, and malformed event ids", () => {
    const secret = generateAutomationWebhookSecret();
    const timestamp = "2026-08-20T10:00:00.000Z";
    const signature = webhookSignature(secret.plaintext, timestamp, "evt_1", "{}");
    expect(validateAutomationWebhook({ encryptedSecret: secret.encrypted, timestamp, eventId: "evt_1", signature, body: "{\"changed\":true}", now: new Date(timestamp) })).toBe("Webhook 签名无效");
    expect(validateAutomationWebhook({ encryptedSecret: secret.encrypted, timestamp, eventId: "evt_1", signature, body: "{}", now: new Date("2026-08-20T10:06:00.000Z") })).toBe("Webhook 时间戳已过期");
    expect(validateAutomationWebhook({ encryptedSecret: secret.encrypted, timestamp, eventId: "bad id", signature, body: "{}", now: new Date(timestamp) })).toBe("Webhook event id 格式不正确");
  });
});
