import { describe, expect, it } from "vitest";

import { encryptConnectorHeaders } from "@/lib/connector-secrets";
import { emailSignature, normalizeEmailRequest, validateEmailRequest } from "@/lib/email-adapter";

process.env.AUTH_SECRET ??= "email-adapter-test-secret-that-is-long-enough";

describe("email inbound adapter", () => {
  it("validates a signed message and normalizes its thread metadata", () => {
    const secret = "email-signing-secret";
    const encrypted = encryptConnectorHeaders({ secret });
    const timestamp = "2026-08-20T10:00:00.000Z";
    const messageId = "<mail-1@example.com>";
    const body = JSON.stringify({ message_id: messageId, from: "person@example.com", to: "agent@example.com", subject: "周报", text: "请整理本周进展", in_reply_to: "<mail-0@example.com>" });
    expect(validateEmailRequest({ encryptedSecret: encrypted, timestamp, messageId, signature: emailSignature(secret, timestamp, messageId, body), body, now: new Date(timestamp) })).toBeNull();
    expect(normalizeEmailRequest(body)).toMatchObject({ messageId, from: "person@example.com", subject: "周报", text: "请整理本周进展", inReplyTo: "<mail-0@example.com>" });
  });

  it("rejects malformed or stale signed messages", () => {
    const secret = "email-signing-secret";
    const encrypted = encryptConnectorHeaders({ secret });
    const timestamp = "2026-08-20T10:00:00.000Z";
    const body = "{}";
    expect(normalizeEmailRequest(body)).toBeNull();
    expect(validateEmailRequest({ encryptedSecret: encrypted, timestamp, messageId: "bad id", signature: "v1=bad", body, now: new Date(timestamp) })).toBe("邮件 message id 格式不正确");
  });
});
